import asyncio
import urllib.request
import pytest
from cs2demos.proxy import ProxyRotator, load_proxy_entries, parse_proxy_entry


def test_parse_proxy_entry_auth_and_masking():
    p = parse_proxy_entry("http://myuser:mypass@1.2.3.4:8080")
    assert p.host == "1.2.3.4"
    assert p.port == 8080
    assert p.username == "myuser"
    assert p.password == "mypass"
    assert p.auth_header == "Basic bXl1c2VyOm15cGFzcw=="
    assert p.masked == "http://myuser:***@1.2.3.4:8080"
    assert "mypass" not in p.masked


def test_parse_proxy_entry_ip_port_user_pass():
    p = parse_proxy_entry("45.38.107.97:6014:jfkcbitt:cktplmhuhvgz")
    assert p.host == "45.38.107.97"
    assert p.port == 6014
    assert p.username == "jfkcbitt"
    assert p.password == "cktplmhuhvgz"
    assert p.auth_header is not None
    assert "cktplmhuhvgz" not in p.masked


def test_parse_proxy_entry_no_auth():
    p = parse_proxy_entry("http://1.2.3.4:8080")
    assert p.host == "1.2.3.4"
    assert p.port == 8080
    assert p.username is None
    assert p.auth_header is None
    assert p.masked == "http://1.2.3.4:8080"


def test_proxy_rotator_index_selection():
    rotator = ProxyRotator("http://u1:p1@h1:80, http://u2:p2@h2:80", index=1)
    assert rotator.index == 1
    assert rotator.current.host == "h2"


def test_load_proxy_entries_pool_and_file(tmp_path):
    # Comma separated
    entries = load_proxy_entries("http://u1:p1@h1:80, http://u2:p2@h2:80")
    assert len(entries) == 2
    assert entries[0].host == "h1"
    assert entries[1].host == "h2"

    # From file
    f = tmp_path / "proxies.txt"
    f.write_text("# comment\nhttp://u1:p1@h1:80\nhttp://u2:p2@h2:80\n\n")
    from_file = load_proxy_entries(f)
    assert len(from_file) == 2
    assert from_file[0].host == "h1"


def test_proxy_rotator_cycle():
    rotator = ProxyRotator("http://u1:p1@h1:80, http://u2:p2@h2:80", index=0)
    assert rotator.is_enabled()
    assert rotator.current.host == "h1"
    rotator.rotate()
    assert rotator.current.host == "h2"
    rotator.rotate()
    assert rotator.current.host == "h1"


def test_proxy_rotator_connect_tunnel():
    async def run_test():
        received_headers = []

        # Mock upstream proxy server that accepts CONNECT and echoes back
        async def mock_upstream(reader, writer):
            line = await reader.readline()
            received_headers.append(line.decode())
            while True:
                h = await reader.readline()
                received_headers.append(h.decode())
                if h in (b"\r\n", b"\n", b""):
                    break
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            data = await reader.read(1024)
            writer.write(b"ECHO:" + data)
            await writer.drain()
            writer.close()

        server = await asyncio.start_server(mock_upstream, "127.0.0.1", 0)
        upstream_port = server.sockets[0].getsockname()[1]

        rotator = ProxyRotator(f"http://testuser:testpass@127.0.0.1:{upstream_port}")
        try:
            local_port = rotator.start()
            assert local_port > 0

            # Connect as a client to rotator
            c_reader, c_writer = await asyncio.open_connection("127.0.0.1", local_port)
            c_writer.write(b"CONNECT destination.test:443 HTTP/1.1\r\nHost: destination.test:443\r\n\r\n")
            await c_writer.drain()

            resp = await c_reader.readline()
            assert b"200 Connection established" in resp
            # Read empty line after 200
            await c_reader.readline()

            # Send payload through tunnel
            c_writer.write(b"hello world")
            await c_writer.drain()
            echo = await c_reader.read(1024)
            assert echo == b"ECHO:hello world"
            c_writer.close()

            # Verify auth header was forwarded to upstream
            headers_str = "".join(received_headers)
            assert "Proxy-Authorization: Basic dGVzdHVzZXI6dGVzdHBhc3M=" in headers_str
        finally:
            rotator.stop()
            server.close()
            await server.wait_closed()

    asyncio.run(run_test())
