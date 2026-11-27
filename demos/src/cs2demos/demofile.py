"""Byte-level repairs for .dem files the parsers reject outright."""

import mmap
import os
import struct
from pathlib import Path

HEADER_BYTES = 16
DEM_PACKET, DEM_SIGNON_PACKET = 7, 8
DEM_IS_COMPRESSED = 64
DEMO_PACKET_DATA_TAG = 0x1A  # CDemoPacket.data, field 3, length-delimited


def _varint(b, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        x = b[i]
        i += 1
        value |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            return value, i


def _encode_varint(value: int) -> bytes:
    out = bytearray()
    while value > 0x7F:
        out.append(value & 0x7F | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _unsnappy(b: bytes) -> bytes:
    size, i = _varint(b, 0)
    out = bytearray()
    while i < len(b):
        tag = b[i]
        i += 1
        kind = tag & 3
        if kind == 0:
            length = tag >> 2
            if length >= 60:
                extra = length - 59
                length = int.from_bytes(b[i:i + extra], "little")
                i += extra
            length += 1
            out += b[i:i + length]
            i += length
            continue
        if kind == 1:
            length, offset = ((tag >> 2) & 7) + 4, ((tag >> 5) << 8) | b[i]
            i += 1
        elif kind == 2:
            length, offset = (tag >> 2) + 1, int.from_bytes(b[i:i + 2], "little")
            i += 2
        else:
            length, offset = (tag >> 2) + 1, int.from_bytes(b[i:i + 4], "little")
            i += 4
        start = len(out) - offset
        if offset >= length:
            out += out[start:start + length]
        else:
            for k in range(length):
                out.append(out[start + k])
    if len(out) != size:
        raise ValueError(f"snappy block decoded to {len(out)} bytes, header says {size}")
    return bytes(out)


def _bits(data: bytes, pos: int, n: int) -> int:
    chunk = int.from_bytes(data[pos >> 3:((pos + n + 7) >> 3) + 1], "little")
    return (chunk >> (pos & 7)) & ((1 << n) - 1)


def _message_header_end(data: bytes, pos: int) -> int:
    """Skips a net message's ubitvar type and varint size; returns (end of header, payload bits)."""
    kind = _bits(data, pos, 6)
    pos += 6 + {0: 0, 16: 4, 32: 8, 48: 28}[kind & 0x30]
    size = shift = 0
    while True:
        x = _bits(data, pos, 8)
        pos += 8
        size |= (x & 0x7F) << shift
        shift += 7
        if not x & 0x80:
            return pos, size * 8


def _complete_messages(data: bytes) -> bytes | None:
    """The payload cut before its half-written last message, or None if every message is whole."""
    total = len(data) * 8
    pos = 0
    while total - pos > 8:
        start = pos
        pos, payload_bits = _message_header_end(data, pos)
        pos += payload_bits
        if pos > total:
            kept = bytearray(data[:(start + 7) >> 3])
            if start & 7:
                kept[-1] &= (1 << (start & 7)) - 1
            return bytes(kept)
    return None


def _trimmed_packet(cmd: int, tick: int, body: bytes, min_bytes: int) -> bytes | None:
    if cmd & DEM_IS_COMPRESSED:
        if _varint(body, 0)[0] < min_bytes:
            return None
        body = _unsnappy(body)
    elif len(body) < min_bytes:
        return None
    if not body or body[0] != DEMO_PACKET_DATA_TAG:
        return None
    length, start = _varint(body, 1)
    kept = _complete_messages(body[start:start + length])
    if kept is None:
        return None
    proto = bytes([DEMO_PACKET_DATA_TAG]) + _encode_varint(len(kept)) + kept
    return _encode_varint(cmd & ~DEM_IS_COMPRESSED) + _encode_varint(tick) + _encode_varint(len(proto)) + proto


def trim_capped_packets(path: Path, min_bits: int) -> int:
    """Drops the half-written last message from packets at least `min_bits` long, rewriting the file.

    Some recordings cap a packet's payload at 750,000 bytes mid-message, and awpy and demoparser2
    then reject the whole demo. Returns how many packets were trimmed."""
    min_bytes = min_bits // 8
    with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        size = len(mm)
        replacements: list[tuple[int, int, bytes]] = []
        i = HEADER_BYTES
        while i < size:
            start = i
            try:
                cmd, i = _varint(mm, i)
                tick, i = _varint(mm, i)
                length, i = _varint(mm, i)
            except IndexError:
                break
            end = i + length
            if end > size:
                break
            if cmd & ~DEM_IS_COMPRESSED in (DEM_PACKET, DEM_SIGNON_PACKET) and length:
                if fixed := _trimmed_packet(cmd, tick, mm[i:end], min_bytes):
                    replacements.append((start, end, fixed))
            i = end
        if not replacements:
            return 0

        def shifted(offset: int) -> int:
            if not offset:
                return offset
            return offset + sum(len(new) - (e - s) for s, e, new in replacements if s < offset)

        file_info, spawn_groups = struct.unpack("<ii", mm[8:16])
        tmp = path.with_name(path.name + ".trimmed")
        with open(tmp, "wb") as out:
            out.write(mm[:8] + struct.pack("<ii", shifted(file_info), shifted(spawn_groups)))
            prev = HEADER_BYTES
            for s, e, new in replacements:
                out.write(mm[prev:s])
                out.write(new)
                prev = e
            out.write(mm[prev:])
    os.replace(tmp, path)
    return len(replacements)
