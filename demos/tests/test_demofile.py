import struct

from cs2demos.demofile import _complete_messages, _encode_varint, _unsnappy, trim_capped_packets


class BitWriter:
    def __init__(self):
        self.bits: list[int] = []

    def write(self, value: int, n: int) -> None:
        self.bits += [(value >> k) & 1 for k in range(n)]

    def message(self, kind: int, payload: bytes, declared: int | None = None) -> None:
        assert kind < 16
        self.write(kind, 6)
        for byte in _encode_varint(len(payload) if declared is None else declared):
            self.write(byte, 8)
        for byte in payload:
            self.write(byte, 8)

    def bytes(self) -> bytes:
        padded = self.bits + [0] * (-len(self.bits) % 8)
        return bytes(sum(padded[i + k] << k for k in range(8)) for i in range(0, len(padded), 8))


def snappy_literal(data: bytes) -> bytes:
    n = len(data) - 1
    return _encode_varint(len(data)) + bytes([61 << 2]) + n.to_bytes(2, "little") + data


def packet_payload(cut: bool) -> tuple[bytes, int]:
    w = BitWriter()
    w.message(4, b"\x01\x02")
    w.message(9, b"\xaa" * 5)
    kept_bits = len(w.bits)
    w.message(7, b"\xff" * 3, declared=40 if cut else None)
    return w.bytes(), kept_bits


def test_complete_messages_drops_only_a_half_written_last_message():
    whole, _ = packet_payload(cut=False)
    assert _complete_messages(whole) is None
    cut, kept_bits = packet_payload(cut=True)
    trimmed = _complete_messages(cut)
    assert len(trimmed) == (kept_bits + 7) // 8
    assert _complete_messages(trimmed) is None
    assert trimmed[:kept_bits // 8] == cut[:kept_bits // 8]


def command(cmd: int, tick: int, body: bytes) -> bytes:
    return _encode_varint(cmd) + _encode_varint(tick) + _encode_varint(len(body)) + body


def demo_packet(payload: bytes) -> bytes:
    return bytes([0x1A]) + _encode_varint(len(payload)) + payload


def test_trim_capped_packets_rewrites_packets_and_header_offsets(tmp_path):
    whole, _ = packet_payload(cut=False)
    cut, kept_bits = packet_payload(cut=True)
    commands = [
        command(7, 1, demo_packet(whole)),
        command(7 | 64, 2, snappy_literal(demo_packet(cut))),
        command(0, 2, b""),
    ]
    spawn_groups = command(15, 2, b"sg")
    file_info = command(2, 2, b"info")
    body = b"".join(commands)
    sg_at = 16 + len(body)
    fi_at = sg_at + len(spawn_groups)
    path = tmp_path / "x.dem"
    path.write_bytes(b"PBDEMS2\0" + struct.pack("<ii", fi_at, sg_at) + body + spawn_groups + file_info)

    assert trim_capped_packets(path, min_bits=8) == 1
    out = path.read_bytes()
    new_fi, new_sg = struct.unpack("<ii", out[8:16])
    assert out[new_sg:new_fi] == spawn_groups
    assert out[new_fi:] == file_info
    trimmed = command(7, 2, demo_packet(_complete_messages(cut)))
    assert out[16:new_sg] == commands[0] + trimmed + commands[2]
    assert _unsnappy(snappy_literal(b"abc")) == b"abc"


def test_trim_capped_packets_skips_packets_below_the_error_offset(tmp_path):
    cut, _ = packet_payload(cut=True)
    path = tmp_path / "x.dem"
    body = command(7, 1, demo_packet(cut))
    original = b"PBDEMS2\0" + struct.pack("<ii", 0, 0) + body
    path.write_bytes(original)
    assert trim_capped_packets(path, min_bits=(len(cut) + 8) * 8) == 0
    assert path.read_bytes() == original
