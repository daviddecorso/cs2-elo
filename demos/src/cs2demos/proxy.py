import asyncio
import base64
import json
import os
import re
import threading
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from dotenv import load_dotenv

from .paths import PROXIES_FILE, PROXY_STATE, REPO_ROOT

load_dotenv(REPO_ROOT / ".env")


@dataclass(frozen=True)
class ProxyEntry:
    url: str
    host: str
    port: int
    username: str | None
    password: str | None
    auth_header: str | None
    masked: str


def parse_proxy_entry(url: str) -> ProxyEntry:
    url = url.strip()
    if "://" not in url:
        parts = url.split(":")
        if len(parts) == 4 and "@" not in url:
            ip, port, user, pwd = parts
            url = f"http://{user}:{pwd}@{ip}:{port}"
        else:
            url = f"http://{url}"
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    username = parsed.username
    password = parsed.password

    auth_header = None
    if username or password:
        userpass = f"{username or ''}:{password or ''}"
        auth_header = f"Basic {base64.b64encode(userpass.encode()).decode()}"

    masked_auth = f"{username}:***@" if username else ""
    masked = f"{parsed.scheme or 'http'}://{masked_auth}{host}:{port}"
    return ProxyEntry(
        url=url,
        host=host,
        port=port,
        username=username,
        password=password,
        auth_header=auth_header,
        masked=masked,
    )


def load_proxy_entries(spec: str | Sequence[str] | Path | None = None) -> list[ProxyEntry]:
    if spec is None:
        spec = os.environ.get("HLTV_PROXY") or os.environ.get("DEMO_PROXY")
    if spec is None and PROXIES_FILE.exists():
        spec = PROXIES_FILE
    if not spec:
        return []

    lines: list[str] = []
    if isinstance(spec, (str, Path)):
        candidate = Path(spec)
        if not candidate.is_file() and isinstance(spec, str):
            repo_candidate = REPO_ROOT / spec
            if repo_candidate.is_file():
                candidate = repo_candidate
        try:
            if candidate.is_file():
                lines = [line.strip() for line in candidate.read_text().splitlines()]
        except OSError:
            pass

    if not lines:
        if isinstance(spec, str):
            parts = re.split(r"[,\s]+", spec.strip())
            lines = [p.strip() for p in parts if p.strip()]
        else:
            lines = [str(p).strip() for p in spec if str(p).strip()]

    return [parse_proxy_entry(line) for line in lines if line and not line.startswith("#")]


def load_proxy_index(total: int) -> int:
    if total <= 1:
        return 0
    try:
        if PROXY_STATE.exists():
            data = json.loads(PROXY_STATE.read_text())
            idx = int(data.get("index", 0))
            return idx % total
    except Exception:
        pass
    return 0


def save_proxy_index(index: int) -> None:
    try:
        PROXY_STATE.parent.mkdir(parents=True, exist_ok=True)
        PROXY_STATE.write_text(json.dumps({"index": index}))
    except Exception:
        pass


class ProxyRotator:
    """Local forward proxy listening on 127.0.0.1 that tunnels traffic to an upstream proxy pool."""

    def __init__(self, spec: str | Sequence[str] | Path | None = None, rotate: bool = False,
                 index: int | None = None) -> None:
        self.spec = spec
        self._proxies: list[ProxyEntry] = load_proxy_entries(spec)
        total = len(self._proxies)
        if total > 0:
            if index is not None:
                self._index = index % total
            else:
                current_idx = load_proxy_index(total)
                if rotate:
                    current_idx = (current_idx + 1) % total
                self._index = current_idx
            save_proxy_index(self._index)
        else:
            self._index = 0

        self._lock = threading.Lock()
        self.port: int | None = None
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: asyncio.Server | None = None
        self._tasks: set[asyncio.Task] = set()

    def is_enabled(self) -> bool:
        return bool(self._proxies)

    @property
    def local_url(self) -> str | None:
        return f"http://127.0.0.1:{self.port}" if self.port else None

    @property
    def index(self) -> int:
        return self._index

    @property
    def current(self) -> ProxyEntry | None:
        with self._lock:
            if not self._proxies:
                return None
            return self._proxies[self._index % len(self._proxies)]

    def rotate(self) -> ProxyEntry | None:
        with self._lock:
            if not self._proxies:
                return None
            self._index = (self._index + 1) % len(self._proxies)
            save_proxy_index(self._index)
            entry = self._proxies[self._index]
        return entry

    def start(self, timeout_s: float = 5.0) -> int:
        if not self._proxies:
            raise RuntimeError("cannot start ProxyRotator: no upstream proxies configured")
        if self._thread and self._thread.is_alive():
            return self.port  # type: ignore[return-value]

        self._ready.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="cs2demos-proxy")
        self._thread.start()
        if not self._ready.wait(timeout=timeout_s):
            raise TimeoutError("local proxy server failed to start in time")
        return self.port  # type: ignore[return-value]

    def stop(self, timeout_s: float = 5.0) -> None:
        if self._loop and self._loop.is_running():
            future = asyncio.run_coroutine_threadsafe(self._cleanup(), self._loop)
            try:
                future.result(timeout=timeout_s)
            except Exception:
                pass
            if self._thread:
                self._thread.join(timeout=timeout_s)
        self._thread = None
        self._loop = None
        self._server = None
        self.port = None

    async def _cleanup(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        tasks = [t for t in list(self._tasks) if t is not asyncio.current_task()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._loop and self._loop.is_running():
            self._loop.stop()

    def _run_loop(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._start_server())
            self._ready.set()
            self._loop.run_forever()
        finally:
            self._loop.run_until_complete(self._loop.shutdown_asyncgens())
            self._loop.close()

    async def _start_server(self) -> None:
        self._server = await asyncio.start_server(self._handle_client, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def _handle_client(self, client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task:
            self._tasks.add(task)
        upstream_writer: asyncio.StreamWriter | None = None
        try:
            line = await client_reader.readline()
            if not line:
                return
            parts = line.decode("latin1", errors="replace").strip().split()
            if len(parts) < 2:
                return
            cmd, target = parts[0], parts[1]

            # Drain client request headers
            while True:
                h = await client_reader.readline()
                if h in (b"\r\n", b"\n", b""):
                    break

            upstream = self.current
            if not upstream:
                client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await client_writer.drain()
                return

            try:
                upstream_reader, upstream_writer = await asyncio.open_connection(upstream.host, upstream.port)
            except Exception:
                client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await client_writer.drain()
                return

            if cmd.upper() == "CONNECT":
                req = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"
                if upstream.auth_header:
                    req += f"Proxy-Authorization: {upstream.auth_header}\r\n"
                req += "\r\n"
                upstream_writer.write(req.encode("latin1"))
                await upstream_writer.drain()

                status_line = await upstream_reader.readline()
                if b"200" not in status_line:
                    detail = status_line.decode("latin1", errors="replace").strip()
                    reasons = []
                    while True:
                        rh = await upstream_reader.readline()
                        if rh in (b"\r\n", b"\n", b""):
                            break
                        decoded_h = rh.decode("latin1", errors="replace").strip()
                        if any(k in decoded_h.lower() for k in ("reason", "error", "message")):
                            reasons.append(decoded_h)
                    reason_msg = f" ({'; '.join(reasons)})" if reasons else ""
                    print(f"Proxy upstream refused connection: {detail}{reason_msg}")
                    client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                    await client_writer.drain()
                    return

                # Drain upstream response headers
                while True:
                    rh = await upstream_reader.readline()
                    if rh in (b"\r\n", b"\n", b""):
                        break

                client_writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
                await client_writer.drain()

                await asyncio.gather(
                    self._pipe(client_reader, upstream_writer),
                    self._pipe(upstream_reader, client_writer),
                )
            else:
                req = f"{cmd} {target} HTTP/1.1\r\n"
                if upstream.auth_header:
                    req += f"Proxy-Authorization: {upstream.auth_header}\r\n"
                req += "\r\n"
                upstream_writer.write(req.encode("latin1"))
                await upstream_writer.drain()

                await asyncio.gather(
                    self._pipe(client_reader, upstream_writer),
                    self._pipe(upstream_reader, client_writer),
                )
        except Exception:
            pass
        finally:
            if upstream_writer:
                try:
                    upstream_writer.close()
                    await upstream_writer.wait_closed()
                except Exception:
                    pass
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except Exception:
                pass
            if task:
                self._tasks.discard(task)

    async def _pipe(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except (asyncio.CancelledError, ConnectionResetError, BrokenPipeError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass
