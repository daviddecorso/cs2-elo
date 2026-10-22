"""HLTV access through a headed browser profile you've cleared Cloudflare in by hand.

Every navigation goes through one rate limiter with a per-run cap. A challenge page stops the run;
nothing here retries or tries to get past it automatically.
"""

import random
import re
import time
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, sync_playwright

from .paths import HLTV_CACHE, HLTV_PROFILE

BASE = "https://www.hltv.org"
MIN_INTERVAL_S = 15.0
JITTER_S = 10.0
DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
DEMO_LINK = re.compile(r'(?:href|data-demo-link)="(/download/demo/\d+)"')


class ChallengeError(Exception):
    pass


class PageBudgetExhausted(Exception):
    pass


def demo_path_from_html(html: str) -> str | None:
    m = DEMO_LINK.search(html)
    return m.group(1) if m else None


def _is_challenge(page: Page) -> bool:
    title = page.title().lower()
    return "just a moment" in title or "attention required" in title or page.locator("#challenge-form, #cf-challenge-running").count() > 0


class Hltv:
    def __init__(self, max_pages: int, profile: Path = HLTV_PROFILE, cache: Path = HLTV_CACHE) -> None:
        self.max_pages, self.profile, self.cache = max_pages, profile, cache
        self.pages_used = 0
        self._last = 0.0
        self._pw = None
        self._ctx: BrowserContext | None = None

    def __enter__(self) -> "Hltv":
        return self

    def __exit__(self, *exc) -> None:
        if self._ctx:
            self._ctx.close()
        if self._pw:
            self._pw.stop()

    def _context(self) -> BrowserContext:
        if not self._ctx:
            self.profile.mkdir(parents=True, exist_ok=True)
            self._pw = sync_playwright().start()
            self._ctx = self._pw.chromium.launch_persistent_context(
                str(self.profile), headless=False, accept_downloads=True, viewport={"width": 1280, "height": 900}
            )
        return self._ctx

    def _page(self) -> Page:
        ctx = self._context()
        return ctx.pages[0] if ctx.pages else ctx.new_page()

    def _wait_turn(self) -> None:
        if self.pages_used >= self.max_pages:
            raise PageBudgetExhausted(f"used all {self.max_pages} HLTV requests for this run")
        wait = self._last + MIN_INTERVAL_S + random.uniform(0, JITTER_S) - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        self.pages_used += 1

    def login(self, timeout_s: int = 300) -> None:
        page = self._page()
        page.goto(BASE, wait_until="domcontentloaded")
        print("Clear any Cloudflare check in the browser window; waiting...")
        deadline = time.monotonic() + timeout_s
        while _is_challenge(page) or "hltv" not in page.title().lower():
            if time.monotonic() > deadline:
                raise ChallengeError(f"still on a challenge page after {timeout_s}s")
            page.wait_for_timeout(2000)

    def match_page(self, hltv_id: int) -> str:
        cached = self.cache / f"match-{hltv_id}.html"
        if cached.exists():
            return cached.read_text()
        self._wait_turn()
        page = self._page()
        page.goto(f"{BASE}/matches/{hltv_id}/match", wait_until="domcontentloaded")
        if _is_challenge(page):
            raise ChallengeError("HLTV served a Cloudflare challenge; run `uv run cs2demos login`")
        html = page.content()
        self.cache.mkdir(parents=True, exist_ok=True)
        cached.write_text(html)
        return html

    def download(self, demo_path: str, dest_stem: Path) -> Path:
        """Streams through the browser so cookies apply; the file lands as `<dest_stem>.<ext>`."""
        self._wait_turn()
        page = self._page()
        with page.expect_download(timeout=DOWNLOAD_TIMEOUT_MS) as info:
            page.evaluate("url => { window.location.href = url }", BASE + demo_path)
        download = info.value
        ext = Path(download.suggested_filename).suffix or ".bin"
        dest = dest_stem.with_suffix(ext)
        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.with_suffix(ext + ".part")
        download.save_as(partial)
        if failure := download.failure():
            partial.unlink(missing_ok=True)
            raise RuntimeError(f"download of {demo_path} failed: {failure}")
        partial.rename(dest)
        return dest
