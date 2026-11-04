"""HLTV access through a headed browser profile you've cleared Cloudflare in by hand.

Every navigation goes through one rate limiter with a per-run cap. A challenge page stops the run;
nothing here retries or tries to get past it automatically.
"""

import asyncio
import json
import random
import re
import shutil
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Coroutine

import nodriver as uc

from .paths import HLTV_CACHE, HLTV_PROFILE

BASE = "https://www.hltv.org"
MIN_INTERVAL_S = 15.0
JITTER_S = 10.0
DOWNLOAD_TIMEOUT_S = 30 * 60
BROWSER_START_ATTEMPTS = 3
SERVER_ERROR_TITLE = re.compile(r"<title>[^<]*\|\s*5\d\d:")
DEMO_LINK = re.compile(r'(?:href|data-demo-link)="(/download/demo/\d+)"')
RESULTS_PAGE_SIZE = 100
RESULTS_MAX_PAGES = 3
RESULTS_JS = """() => [...document.querySelectorAll('.results-all .result-con')].flatMap(el => {
  const a = el.querySelector('a[href^="/matches/"]');
  const id = a && a.getAttribute('href').match(/^\\/matches\\/(\\d+)/);
  const teams = [...el.querySelectorAll('.team')].map(t => t.textContent.trim());
  const score = [...el.querySelectorAll('.result-score span')].map(s => parseInt(s.textContent, 10));
  if (!id || teams.length < 2 || score.length < 2) return [];
  return [{id: +id[1], team1: teams[0], team2: teams[1], score1: score[0], score2: score[1]}];
})"""


class ChallengeError(Exception):
    pass


class PageBudgetExhausted(Exception):
    pass


class ServerError(Exception):
    pass


def is_server_error(html: str) -> bool:
    """Cloudflare's 5xx pages, e.g. "hltv.org | 520: Web server is returning an unknown error"."""
    return bool(SERVER_ERROR_TITLE.search(html))


def demo_path_from_html(html: str) -> str | None:
    m = DEMO_LINK.search(html)
    return m.group(1) if m else None


async def _is_challenge(tab: uc.Tab) -> bool:
    try:
        title = ((await tab.evaluate("document.title")) or "").lower()
        if "just a moment" in title or "attention required" in title:
            return True
        has_cf = await tab.evaluate("Boolean(document.querySelector('#challenge-form, #cf-challenge-running'))")
        return bool(has_cf)
    except Exception:
        return False


async def _navigate(tab: uc.Tab, url: str, timeout_s: float = 30.0) -> None:
    await tab.get(url)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            state = await tab.evaluate("document.readyState")
            if state in ("interactive", "complete"):
                return
        except Exception:
            pass
        await asyncio.sleep(0.2)


class Hltv:
    def __init__(self, max_pages: int, profile: Path = HLTV_PROFILE, cache: Path = HLTV_CACHE) -> None:
        self.max_pages, self.profile, self.cache = max_pages, profile, cache
        self.pages_used = 0
        self._last = 0.0
        self._results: dict[str, list[dict]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._browser: uc.Browser | None = None

    def __enter__(self) -> "Hltv":
        return self

    def __exit__(self, *exc) -> None:
        if self._browser:
            process = self._browser._process
            self._browser.stop()
            # nodriver's atexit hook stops any browser whose returncode is unset, on the then-closed loop.
            if process and self._loop and not self._loop.is_closed():
                try:
                    self._loop.run_until_complete(asyncio.wait_for(process.wait(), 10))
                except TimeoutError:
                    process.kill()
                    self._loop.run_until_complete(process.wait())
            self._browser = None
        if self._loop and not self._loop.is_closed():
            self._loop.run_until_complete(asyncio.sleep(0.1))
            self._loop.close()
            self._loop = None

    def _run(self, coro: Coroutine[Any, Any, Any]) -> Any:
        if not self._loop or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
        return self._loop.run_until_complete(coro)

    def _get_browser(self) -> uc.Browser:
        if not self._browser:
            self.profile.mkdir(parents=True, exist_ok=True)
            self._browser = self._run(self._start_browser())
        return self._browser

    async def _start_browser(self) -> uc.Browser:
        # nodriver gives Chrome ~3s to open its debug port, which a cold start after a Chrome update can miss.
        for attempt in range(1, BROWSER_START_ATTEMPTS + 1):
            try:
                return await uc.start(
                    user_data_dir=str(self.profile),
                    headless=False,
                    browser_args=["--window-size=1280,900"],
                )
            except Exception:
                if attempt == BROWSER_START_ATTEMPTS:
                    raise
                # The Chrome that missed the deadline is still running and holds the profile lock.
                registered = uc.util.get_registered_instances()
                for stray in [b for b in registered if not b.info]:
                    registered.discard(stray)
                    if stray._process and stray._process.returncode is None:
                        stray._process.terminate()
                        try:
                            await asyncio.wait_for(stray._process.wait(), 10)
                        except TimeoutError:
                            stray._process.kill()
                            await stray._process.wait()
                print(f"Chrome didn't open its debug port in time; retrying ({attempt}/{BROWSER_START_ATTEMPTS - 1})")
        raise AssertionError("unreachable")

    def _tab(self) -> uc.Tab:
        browser = self._get_browser()
        return browser.main_tab

    def _wait_turn(self) -> None:
        if self.pages_used >= self.max_pages:
            raise PageBudgetExhausted(f"used all {self.max_pages} HLTV requests for this run")
        wait = self._last + MIN_INTERVAL_S + random.uniform(0, JITTER_S) - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        self.pages_used += 1

    def login(self, timeout_s: int = 300) -> None:
        tab = self._tab()
        self._run(_navigate(tab, BASE))
        print("Clear any Cloudflare check in the browser window; waiting...")
        deadline = time.monotonic() + timeout_s
        while self._run(_is_challenge(tab)) or "hltv" not in self._run(tab.evaluate("document.title")).lower():
            if time.monotonic() > deadline:
                raise ChallengeError(f"still on a challenge page after {timeout_s}s")
            time.sleep(2)

    def match_page(self, hltv_id: int) -> str:
        cached = self.cache / f"match-{hltv_id}.html"
        if cached.exists() and not is_server_error(html := cached.read_text()):
            return html
        self._wait_turn()
        tab = self._tab()
        self._run(_navigate(tab, f"{BASE}/matches/{hltv_id}/match"))
        if self._run(_is_challenge(tab)):
            raise ChallengeError("HLTV served a Cloudflare challenge; run `uv run cs2demos login`")
        html = self._run(tab.get_content())
        if is_server_error(html):
            raise ServerError(f"HLTV match {hltv_id} returned a server error page")
        self.cache.mkdir(parents=True, exist_ok=True)
        cached.write_text(html)
        return html

    def results_day(self, day: str) -> list[dict]:
        """HLTV's results for one `YYYY-MM-DD`. Cached once the day is settled."""
        if day in self._results:
            return self._results[day]
        cached = self.cache / f"results-{day}.json"
        if cached.exists():
            return json.loads(cached.read_text())
        rows: dict[int, dict] = {}
        for offset in range(0, RESULTS_PAGE_SIZE * RESULTS_MAX_PAGES, RESULTS_PAGE_SIZE):
            self._wait_turn()
            tab = self._tab()
            self._run(_navigate(tab, f"{BASE}/results?startDate={day}&endDate={day}&offset={offset}"))
            if self._run(_is_challenge(tab)):
                raise ChallengeError("HLTV served a Cloudflare challenge; run `uv run cs2demos login`")
            raw = self._run(tab.evaluate(f"JSON.stringify(({RESULTS_JS})())"))
            found = json.loads(raw or "[]")
            rows.update((r["id"], r) for r in found)
            if len(found) < RESULTS_PAGE_SIZE:
                break
        out = self._results[day] = list(rows.values())
        if day < (date.today() - timedelta(days=2)).isoformat():
            self.cache.mkdir(parents=True, exist_ok=True)
            cached.write_text(json.dumps(out))
        return out

    def download(self, demo_path: str, dest_stem: Path) -> Path:
        """Streams through the browser so cookies apply; the file lands as `<dest_stem>.<ext>`."""
        self._wait_turn()
        tab = self._tab()
        staging_dir = dest_stem.parent / f".download-{dest_stem.name}"
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        staging_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._run(tab.set_download_path(staging_dir))
            full_url = BASE + demo_path
            self._run(tab.evaluate(f"window.location.href = {json.dumps(full_url)}"))
            deadline = time.monotonic() + DOWNLOAD_TIMEOUT_S
            while time.monotonic() < deadline:
                time.sleep(0.5)
                files = [f for f in staging_dir.iterdir() if f.is_file()]
                crdownloads = [f for f in files if f.name.endswith(".crdownload")]
                completed = [f for f in files if not f.name.endswith(".crdownload") and f.stat().st_size > 0]
                if completed and not crdownloads:
                    downloaded = completed[0]
                    ext = downloaded.suffix or ".bin"
                    dest = dest_stem.with_suffix(ext)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    downloaded.replace(dest)
                    return dest
            raise TimeoutError(f"download of {demo_path} timed out")
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)
