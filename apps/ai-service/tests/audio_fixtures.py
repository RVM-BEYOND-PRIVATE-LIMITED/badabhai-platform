"""Synthetic audio builders for the D-2 chunked-STT tests.

Builds REAL (if tiny) containers in-memory so ``app.audio_chunk`` parses actual
byte structure rather than a mock — no ffmpeg, no fixture binaries in the repo,
no network:

- ``build_m4a`` — a non-fragmented ISO BMFF file (``ftyp`` + ``mdat`` + ``moov``)
  carrying AAC-LC frames, matching what the ADR-0029 recorder writes
  (``voice-notes/{workerId}/{uuid}.m4a``). ``mdat`` is written BEFORE ``moov`` so
  the ``stco`` absolute file offsets are known when the tables are built.
- ``build_wav`` — a canonical 16-bit PCM RIFF/WAVE file.

The AAC frame payloads are filler bytes, not encodable audio: every test that
would "decode" them stubs the provider. What matters is that the sample tables
(``stts``/``stsz``/``stsc``/``stco``) describe them truthfully, which is exactly
what the splitter reads.
"""

from __future__ import annotations

import struct

# AAC-LC @ 16 kHz mono: 1024 samples/frame at a 16000 timescale => delta 1024
# (64 ms/frame). Mirrors the recorder's AAC-LC profile.
AAC_SAMPLE_RATE = 16000
AAC_SAMPLES_PER_FRAME = 1024
AAC_FRAME_SECONDS = AAC_SAMPLES_PER_FRAME / AAC_SAMPLE_RATE  # 0.064

# AudioSpecificConfig for AAC-LC (object_type 2), sampling_frequency_index 8
# (=16 kHz), channel_config 1 (mono), packed 5+4+4 bits then padded to 2 bytes.
_ASC_AAC_LC_16K_MONO = bytes([0x14, 0x08])


def _box(box_type: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload) + 8) + box_type + payload


def _full_box(box_type: bytes, payload: bytes, *, version: int = 0, flags: int = 0) -> bytes:
    return _box(box_type, struct.pack(">B", version) + flags.to_bytes(3, "big") + payload)


def _descriptor(tag: int, payload: bytes) -> bytes:
    """MPEG-4 descriptor with a single-byte length (payloads here are < 128 B)."""
    assert len(payload) < 0x80, "test descriptors stay single-byte-length"
    return bytes([tag, len(payload)]) + payload


def _esds() -> bytes:
    dec_specific = _descriptor(0x05, _ASC_AAC_LC_16K_MONO)
    decoder_config = _descriptor(
        0x04,
        bytes([0x40, 0x15])  # objectTypeIndication=AAC, streamType=audio
        + b"\x00\x00\x00"  # bufferSizeDB (3 bytes)
        + struct.pack(">II", 0, 0)  # maxBitrate, avgBitrate
        + dec_specific,
    )
    sl_config = _descriptor(0x06, bytes([0x02]))
    es = _descriptor(
        0x03,
        struct.pack(">H", 1) + bytes([0x00]) + decoder_config + sl_config,  # ES_ID, flags=0
    )
    return _full_box(b"esds", es)


def _mp4a_sample_entry() -> bytes:
    body = (
        b"\x00" * 6  # reserved
        + struct.pack(">H", 1)  # data_reference_index
        + b"\x00" * 8  # version, revision, vendor
        + struct.pack(">H", 1)  # channelcount
        + struct.pack(">H", 16)  # samplesize
        + b"\x00" * 4  # pre_defined + reserved
        + struct.pack(">I", AAC_SAMPLE_RATE << 16)  # samplerate (16.16 fixed)
        + _esds()
    )
    return _box(b"mp4a", body)


def build_m4a(
    frame_count: int,
    *,
    frame_size: int = 64,
    samples_per_chunk: int = 8,
    use_co64: bool = False,
) -> tuple[bytes, list[bytes]]:
    """Return ``(file_bytes, frame_payloads)`` for an AAC-LC ``.m4a`` of
    ``frame_count`` frames (``frame_count * 0.064`` seconds).

    Each frame payload is unique (``frame_size`` bytes seeded by its index) so a
    test can assert WHICH frames landed in WHICH segment, and in what order.
    """
    frames = [bytes([(i * 7 + j) % 251 for j in range(frame_size)]) for i in range(frame_count)]

    ftyp = _box(b"ftyp", b"M4A " + struct.pack(">I", 0) + b"M4A mp42isom")
    mdat_payload = b"".join(frames)
    mdat = _box(b"mdat", mdat_payload)
    # mdat is written second => its payload starts after ftyp + the 8-byte header.
    first_frame_offset = len(ftyp) + 8

    # Chunk offsets: group frames into chunks of `samples_per_chunk`.
    chunk_offsets: list[int] = []
    offset = first_frame_offset
    for i in range(0, frame_count, samples_per_chunk):
        chunk_offsets.append(offset)
        offset += sum(len(f) for f in frames[i : i + samples_per_chunk])

    mdhd = _full_box(
        b"mdhd",
        struct.pack(">IIII", 0, 0, AAC_SAMPLE_RATE, frame_count * AAC_SAMPLES_PER_FRAME)
        + struct.pack(">HH", 0x55C4, 0),  # language 'und' + pre_defined
    )
    hdlr = _full_box(b"hdlr", struct.pack(">I", 0) + b"soun" + b"\x00" * 12 + b"\x00")
    stsd = _full_box(b"stsd", struct.pack(">I", 1) + _mp4a_sample_entry())
    stts = _full_box(
        b"stts", struct.pack(">I", 1) + struct.pack(">II", frame_count, AAC_SAMPLES_PER_FRAME)
    )
    stsz = _full_box(
        b"stsz",
        struct.pack(">II", 0, frame_count) + b"".join(struct.pack(">I", len(f)) for f in frames),
    )
    stsc = _full_box(b"stsc", struct.pack(">I", 1) + struct.pack(">III", 1, samples_per_chunk, 1))
    if use_co64:
        offsets_box = _full_box(
            b"co64",
            struct.pack(">I", len(chunk_offsets))
            + b"".join(struct.pack(">Q", o) for o in chunk_offsets),
        )
    else:
        offsets_box = _full_box(
            b"stco",
            struct.pack(">I", len(chunk_offsets))
            + b"".join(struct.pack(">I", o) for o in chunk_offsets),
        )

    stbl = _box(b"stbl", stsd + stts + stsc + stsz + offsets_box)
    minf = _box(b"minf", _box(b"smhd", b"\x00" * 8) + stbl)
    mdia = _box(b"mdia", mdhd + hdlr + minf)
    trak = _box(b"trak", mdia)
    moov = _box(b"moov", _full_box(b"mvhd", b"\x00" * 96) + trak)

    return ftyp + mdat + moov, frames


def build_crafted_m4a(
    *,
    frame_count: int,
    timescale: int = AAC_SAMPLE_RATE,
    delta: int = AAC_SAMPLES_PER_FRAME,
    frame_size: int = 1,
    declared_sample_count: int | None = None,
    stsc_first_chunk: int = 1,
    truncate_stts_to: int | None = None,
) -> bytes:
    """Build a HOSTILE .m4a whose sample tables lie, for the fail-closed tests.

    Unlike ``build_m4a`` this does NOT materialize per-frame payloads — that is
    the point. The MP4 tables are run-length/implicit encoded, so a tiny file can
    *declare* an enormous stream:

    - ``frame_count`` + ``delta``/``timescale`` set the DECLARED duration
      (``frame_count * delta / timescale`` seconds) — the H-1 spend primitive:
      a ~200KB file can claim 200,000s and demand 6,780 provider calls.
    - ``declared_sample_count`` overstates ``stsz``'s count with a FIXED
      ``sample_size`` (no per-frame bytes needed) — the M-2 memory primitive.
    - ``stsc_first_chunk`` crafts the NEXT stsc entry's ``first_chunk`` to drive
      the chunk index past the offset table — the M-1(i) IndexError primitive.
    - ``truncate_stts_to`` cuts the stts box short so its header read would spill
      into the neighbouring box — the M-1(iii) struct.error primitive.
    """
    ftyp = _box(b"ftyp", b"M4A " + struct.pack(">I", 0) + b"M4A mp42isom")
    # mdat stays TINY and independent of the declared frame_count — that IS the
    # attack (a ~500B file declaring millions of frames / 200,000 seconds). Cap it
    # so a hostile fixture never allocates the stream it merely claims to have.
    mdat = _box(b"mdat", bytes(min(frame_count * frame_size, 4096)))
    first = len(ftyp) + 8

    # mdhd.duration is a u32; a hostile frame_count*delta can exceed it. The
    # parser only reads `timescale`, so clamp rather than overflow the fixture.
    mdhd = _full_box(
        b"mdhd",
        struct.pack(">IIII", 0, 0, timescale, min(frame_count * delta, 0xFFFFFFFF)),
    )
    hdlr = _full_box(b"hdlr", struct.pack(">I", 0) + b"soun" + b"\x00" * 13)
    stsd = _full_box(b"stsd", struct.pack(">I", 1) + _mp4a_sample_entry())

    stts_payload = struct.pack(">I", 1) + struct.pack(">II", frame_count, delta)
    stts = _full_box(b"stts", stts_payload)
    if truncate_stts_to is not None:
        stts = stts[:truncate_stts_to]

    # Fixed sample_size => the size list is SYNTHESIZED from the count alone.
    stsz = _full_box(
        b"stsz",
        struct.pack(">II", frame_size, declared_sample_count or frame_count),
    )

    if stsc_first_chunk != 1:
        # Two entries: a valid first, then one whose first_chunk is absurd. The
        # loop derives `last_chunk` from the SECOND entry's value.
        stsc_payload = (
            struct.pack(">I", 2)
            + struct.pack(">III", 1, 1, 1)
            + struct.pack(">III", stsc_first_chunk, 1, 1)
        )
    else:
        stsc_payload = struct.pack(">I", 1) + struct.pack(">III", 1, frame_count, 1)
    stsc = _full_box(b"stsc", stsc_payload)

    stco = _full_box(b"stco", struct.pack(">I", 1) + struct.pack(">I", first))
    stbl = _box(b"stbl", stsd + stts + stsc + stsz + stco)
    minf = _box(b"minf", _box(b"smhd", b"\x00" * 8) + stbl)
    mdia = _box(b"mdia", mdhd + hdlr + minf)
    moov = _box(b"moov", _full_box(b"mvhd", b"\x00" * 96) + _box(b"trak", mdia))
    return ftyp + mdat + moov


def build_wav(duration_seconds: float, *, sample_rate: int = 16000) -> bytes:
    """Canonical 16-bit mono PCM RIFF/WAVE of ``duration_seconds``."""
    n_frames = int(round(duration_seconds * sample_rate))
    block_align = 2  # 1 channel * 16 bits
    data = bytes(n_frames * block_align)
    fmt = struct.pack(
        "<HHIIHH", 1, 1, sample_rate, sample_rate * block_align, block_align, 16
    )
    return b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + len(data)),
            b"WAVE",
            b"fmt ",
            struct.pack("<I", 16),
            fmt,
            b"data",
            struct.pack("<I", len(data)),
            data,
        ]
    )
