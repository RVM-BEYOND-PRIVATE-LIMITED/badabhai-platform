"""Pure-python audio segmentation for the chunked-sync STT path (D-2).

WHY THIS EXISTS: Sarvam's synchronous ``speech-to-text`` accepts audio UNDER 30s
only (``stt.SARVAM_SYNC_MAX_SECONDS``), while the platform accepts voice notes up
to 120s (``MAX_VOICE_NOTE_SECONDS`` in ``packages/types``). The provider's
batch/async STT API contract is NOT known to this codebase (only the sync REST
endpoint is), so the 30-120s path is CHUNKED SYNC: split the stored audio into
<30s segments on codec-frame boundaries, transcribe each segment with the same
sync endpoint, and concatenate deterministically (``app/stt.py`` owns that).

WHY PURE PYTHON (no ffmpeg): the ai-service ships with NO container image and no
system-package story (bare uvicorn + pip requirements; CI is ``setup-python``
only — there is no ai-service Dockerfile to add ffmpeg to), so segmentation must
not shell out. The ADR-0029 upload seam mints ONLY
``voice-notes/{workerId}/{uuid}.m4a`` (AAC-LC in an MP4 container) — the one
format the production pipeline stores. Supported here:

- ``.m4a``/``.mp4`` (AAC-LC in ISO BMFF): parse the ``moov`` sample tables
  (``stts``/``stsz``/``stsc``/``stco|co64``) and repackage each window of AAC
  frames as a self-contained ADTS (``.aac``) stream — ``audio/aac`` is already in
  the upload content-type map and needs NO re-encoding (frame-exact, lossless
  repackaging of the original AAC access units).
- ``.wav`` (PCM RIFF): byte-range split of the ``data`` chunk on sample-frame
  boundaries with a rebuilt canonical header.

Anything else (mp3/ogg/opus/webm/...) raises ``AudioChunkError`` — those
containers cannot be split safely without a decoder, and the production seam
never stores them. FAIL CLOSED, never guess.

SPLIT SHAPE: balanced, deterministic. ``n = ceil(total / max_chunk_seconds)``
windows of ~equal duration, boundaries snapped to the first codec frame whose
end-time reaches the target. With ``max_chunk_seconds = 29.5`` and an AAC frame
of <=64ms (1024 samples at >=16kHz) every window stays strictly under the 30s
provider limit, and there is never a degenerate sub-second tail chunk.

PRIVACY: audio BYTES and object keys are never logged here; every raised message
carries only generic strings / sizes / box names (the same discipline as
``app/stt.py`` and ``app/storage.py``).
"""

from __future__ import annotations

import math
import os
import struct
from bisect import bisect_left
from dataclasses import dataclass
from itertools import accumulate

# Sanity ceiling on parsed frame counts — a 120s note is ~5.6k AAC frames
# (@21.3ms) or ~5.8M wav sample-frames; anything past this is a malformed or
# hostile table, not a voice note. Fail closed instead of expanding it.
_MAX_FRAMES = 20_000_000


class AudioChunkError(RuntimeError):
    """Audio cannot be split safely (unsupported/malformed container, fragmented
    MP4, table mismatch, ...). Messages are PII-free by construction."""


@dataclass(frozen=True)
class AudioSegment:
    """One <max_chunk_seconds audio segment, self-contained and provider-ready."""

    index: int
    data: bytes
    filename: str
    content_type: str
    duration_seconds: float


def split_audio(
    audio: bytes, storage_path: str, *, max_chunk_seconds: float
) -> list[AudioSegment]:
    """Split ``audio`` (the full stored object) into ordered, self-contained
    segments of at most ~``max_chunk_seconds`` each (see module docstring for
    the exact boundary-snap guarantee). Raises ``AudioChunkError`` on any
    unsupported or malformed input — the caller fails closed."""
    if max_chunk_seconds <= 0:
        raise AudioChunkError("max_chunk_seconds must be positive")
    ext = os.path.splitext(storage_path)[1].lower()
    if ext in (".m4a", ".mp4"):
        return _split_m4a(audio, max_chunk_seconds)
    if ext == ".wav":
        return _split_wav(audio, max_chunk_seconds)
    raise AudioChunkError(
        f"unsupported container for chunking ({ext or 'no extension'})"
    )


def _chunk_boundaries(frame_end_times: list[float], max_chunk_seconds: float) -> list[int]:
    """Balanced frame-index boundaries: returns the END frame index (exclusive)
    of each window. ``n = ceil(total/max)`` windows; each boundary snaps to the
    first frame whose end-time reaches ``i * total / n`` (so a window exceeds the
    equal-share target by at most ONE frame duration). Deterministic."""
    total = frame_end_times[-1]
    frame_count = len(frame_end_times)
    n_chunks = max(1, math.ceil(total / max_chunk_seconds))
    if n_chunks == 1:
        return [frame_count]
    boundaries: list[int] = []
    prev = 0
    for i in range(1, n_chunks):
        target = total * i / n_chunks
        # First frame index whose end-time >= target; +1 => cut AFTER that frame.
        idx = bisect_left(frame_end_times, target, lo=prev) + 1
        # Keep every window non-empty (>= 1 frame each side of the cut).
        idx = max(prev + 1, min(idx, frame_count - (n_chunks - i)))
        boundaries.append(idx)
        prev = idx
    boundaries.append(frame_count)
    return boundaries


# --- WAV (PCM RIFF) ----------------------------------------------------------


def _split_wav(audio: bytes, max_chunk_seconds: float) -> list[AudioSegment]:
    if len(audio) < 12 or audio[0:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise AudioChunkError("malformed wav (missing RIFF/WAVE header)")

    fmt: bytes | None = None
    data_off: int | None = None
    data_len = 0
    pos = 12
    while pos + 8 <= len(audio):
        chunk_id = audio[pos : pos + 4]
        (chunk_size,) = struct.unpack("<I", audio[pos + 4 : pos + 8])
        body = pos + 8
        if chunk_id == b"fmt ":
            fmt = audio[body : body + chunk_size]
        elif chunk_id == b"data":
            data_off = body
            data_len = min(chunk_size, len(audio) - body)
        pos = body + chunk_size + (chunk_size & 1)  # chunks are 2-byte aligned

    if fmt is None or len(fmt) < 16 or data_off is None:
        raise AudioChunkError("malformed wav (missing fmt/data chunk)")

    audio_format, _channels, sample_rate, _byte_rate, block_align, _bits = struct.unpack(
        "<HHIIHH", fmt[:16]
    )
    # 1 = integer PCM, 3 = IEEE float PCM — both are fixed-rate and byte-splittable.
    if audio_format not in (1, 3) or block_align <= 0 or sample_rate <= 0:
        raise AudioChunkError("unsupported wav encoding (PCM only)")

    n_frames = data_len // block_align
    if n_frames == 0:
        raise AudioChunkError("malformed wav (empty data chunk)")
    if n_frames > _MAX_FRAMES:
        raise AudioChunkError("wav data chunk implausibly large")

    total_seconds = n_frames / sample_rate
    n_chunks = max(1, math.ceil(total_seconds / max_chunk_seconds))
    segments: list[AudioSegment] = []
    for i in range(n_chunks):
        # Integer balanced split — every PCM frame lands in exactly one segment.
        f0 = (n_frames * i) // n_chunks
        f1 = (n_frames * (i + 1)) // n_chunks
        body = audio[data_off + f0 * block_align : data_off + f1 * block_align]
        segments.append(
            AudioSegment(
                index=i,
                data=_wav_header(fmt[:16], len(body)) + body,
                filename=f"chunk_{i:02d}.wav",
                content_type="audio/wav",
                duration_seconds=(f1 - f0) / sample_rate,
            )
        )
    return segments


def _wav_header(fmt16: bytes, data_len: int) -> bytes:
    """Canonical 44-byte RIFF/WAVE header around a bare PCM ``data`` body."""
    return b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + data_len),
            b"WAVE",
            b"fmt ",
            struct.pack("<I", 16),
            fmt16,
            b"data",
            struct.pack("<I", data_len),
        ]
    )


# --- M4A / MP4 (AAC-LC in ISO BMFF) -> ADTS segments -------------------------

# ADTS sampling_frequency_index table (ISO 14496-3). Index 15 = explicit 24-bit
# frequency — not emitted by standard AAC-LC recorders; rejected fail-closed.
_ADTS_MAX_FRAME_LEN = 0x1FFF  # 13-bit aac_frame_length field (header + payload)


@dataclass(frozen=True)
class _AacConfig:
    object_type: int  # 1..4 (2 = AAC-LC); ADTS profile = object_type - 1
    sampling_frequency_index: int  # 0..12 (table index, NOT Hz)
    channel_config: int  # 1..7


@dataclass(frozen=True)
class _Mp4AudioTrack:
    config: _AacConfig
    frame_ranges: list[tuple[int, int]]  # (file_offset, size) per AAC frame
    frame_durations: list[float]  # seconds per frame (from stts/timescale)


def _split_m4a(audio: bytes, max_chunk_seconds: float) -> list[AudioSegment]:
    track = _parse_mp4_audio_track(audio)
    end_times = list(accumulate(track.frame_durations))
    boundaries = _chunk_boundaries(end_times, max_chunk_seconds)

    segments: list[AudioSegment] = []
    start = 0
    for i, end in enumerate(boundaries):
        parts: list[bytes] = []
        for offset, size in track.frame_ranges[start:end]:
            parts.append(_adts_header(track.config, size))
            parts.append(audio[offset : offset + size])
        duration = end_times[end - 1] - (end_times[start - 1] if start else 0.0)
        segments.append(
            AudioSegment(
                index=i,
                data=b"".join(parts),
                filename=f"chunk_{i:02d}.aac",
                content_type="audio/aac",
                duration_seconds=duration,
            )
        )
        start = end
    return segments


def _adts_header(config: _AacConfig, payload_len: int) -> bytes:
    """7-byte ADTS header (MPEG-4, layer 00, no CRC) for one raw AAC frame."""
    frame_len = payload_len + 7
    if frame_len > _ADTS_MAX_FRAME_LEN:
        raise AudioChunkError("aac frame too large for adts")
    profile = config.object_type - 1
    header = bytearray(7)
    header[0] = 0xFF
    header[1] = 0xF1  # syncword low nibble + MPEG-4 + layer 00 + protection_absent
    header[2] = (
        (profile & 0x3) << 6
        | (config.sampling_frequency_index & 0xF) << 2
        | (config.channel_config >> 2) & 0x1
    )
    header[3] = (config.channel_config & 0x3) << 6 | (frame_len >> 11) & 0x3
    header[4] = (frame_len >> 3) & 0xFF
    header[5] = (frame_len & 0x7) << 5 | 0x1F  # buffer fullness = 0x7FF (VBR)
    header[6] = 0xFC  # fullness low bits + 1 raw data block
    return bytes(header)


def _iter_boxes(buf: bytes, start: int, end: int):
    """Yield ``(type, payload_start, payload_end)`` for ISO BMFF boxes in
    ``buf[start:end]``. Handles 64-bit ``largesize`` and size==0 (to end)."""
    pos = start
    while pos + 8 <= end:
        (size,) = struct.unpack(">I", buf[pos : pos + 4])
        box_type = buf[pos + 4 : pos + 8]
        header = 8
        if size == 1:
            if pos + 16 > end:
                raise AudioChunkError("malformed mp4 (truncated largesize)")
            (size,) = struct.unpack(">Q", buf[pos + 8 : pos + 16])
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            raise AudioChunkError("malformed mp4 (bad box size)")
        yield box_type, pos + header, pos + size
        pos += size


def _find_box(buf: bytes, start: int, end: int, box_type: bytes) -> tuple[int, int] | None:
    for kind, payload_start, payload_end in _iter_boxes(buf, start, end):
        if kind == box_type:
            return payload_start, payload_end
    return None


def _require_box(buf: bytes, start: int, end: int, box_type: bytes) -> tuple[int, int]:
    found = _find_box(buf, start, end, box_type)
    if found is None:
        raise AudioChunkError(f"malformed mp4 (missing {box_type.decode('latin1')} box)")
    return found


def _parse_mp4_audio_track(buf: bytes) -> _Mp4AudioTrack:
    moov = _find_box(buf, 0, len(buf), b"moov")
    if moov is None:
        raise AudioChunkError("malformed mp4 (no moov box)")

    for kind, trak_start, trak_end in _iter_boxes(buf, *moov):
        if kind != b"trak":
            continue
        mdia = _find_box(buf, trak_start, trak_end, b"mdia")
        if mdia is None:
            continue
        hdlr = _find_box(buf, *mdia, b"hdlr")
        # hdlr fullbox: 4 (version/flags) + 4 (pre_defined) then handler_type.
        if hdlr is None or buf[hdlr[0] + 8 : hdlr[0] + 12] != b"soun":
            continue

        timescale = _parse_mdhd_timescale(buf, *_require_box(buf, *mdia, b"mdhd"))
        minf = _require_box(buf, *mdia, b"minf")
        stbl = _require_box(buf, *minf, b"stbl")

        config = _parse_stsd_aac_config(buf, *_require_box(buf, *stbl, b"stsd"))
        deltas = _parse_stts(buf, *_require_box(buf, *stbl, b"stts"))
        sizes = _parse_stsz(buf, *_require_box(buf, *stbl, b"stsz"))
        stsc_entries = _parse_stsc(buf, *_require_box(buf, *stbl, b"stsc"))
        chunk_offsets = _parse_chunk_offsets(buf, stbl)

        if len(deltas) != len(sizes):
            raise AudioChunkError("malformed mp4 (stts/stsz sample count mismatch)")
        frame_ranges = _sample_file_ranges(len(buf), sizes, stsc_entries, chunk_offsets)
        durations = [delta / timescale for delta in deltas]
        if not frame_ranges:
            raise AudioChunkError("malformed mp4 (audio track has no samples)")
        return _Mp4AudioTrack(
            config=config, frame_ranges=frame_ranges, frame_durations=durations
        )

    raise AudioChunkError("no audio (soun) track in mp4")


def _parse_mdhd_timescale(buf: bytes, start: int, end: int) -> int:
    version = buf[start]
    offset = start + (20 if version == 1 else 12)  # v1: 64-bit times
    if offset + 4 > end:
        raise AudioChunkError("malformed mp4 (truncated mdhd)")
    (timescale,) = struct.unpack(">I", buf[offset : offset + 4])
    if timescale <= 0:
        raise AudioChunkError("malformed mp4 (zero mdhd timescale)")
    return timescale


def _parse_stsd_aac_config(buf: bytes, start: int, end: int) -> _AacConfig:
    # stsd fullbox: 4 (version/flags) + 4 (entry_count), then sample entries.
    entry_start = start + 8
    if entry_start + 8 > end:
        raise AudioChunkError("malformed mp4 (truncated stsd)")
    (entry_size,) = struct.unpack(">I", buf[entry_start : entry_start + 4])
    entry_type = buf[entry_start + 4 : entry_start + 8]
    if entry_type != b"mp4a":
        raise AudioChunkError("unsupported mp4 audio codec (mp4a/AAC only)")
    entry_end = min(entry_start + entry_size, end)
    # AudioSampleEntry: 8 (box header) + 6 reserved + 2 data_reference_index
    # + 8 (version/revision/vendor) + 2 channels + 2 samplesize + 2 pre_defined
    # + 2 reserved + 4 samplerate = 36 bytes before the child boxes (esds).
    children_start = entry_start + 36
    if children_start >= entry_end:
        raise AudioChunkError("malformed mp4 (truncated mp4a sample entry)")
    esds = _find_box(buf, children_start, entry_end, b"esds")
    if esds is None:
        raise AudioChunkError("malformed mp4 (mp4a entry missing esds)")
    asc = _parse_esds_audio_specific_config(buf, esds[0] + 4, esds[1])  # +4 fullbox
    return _parse_audio_specific_config(asc)


def _read_descriptor(buf: bytes, pos: int, end: int) -> tuple[int, int, int]:
    """MPEG-4 descriptor: tag byte + expandable (0x80-continued) length. Returns
    ``(tag, body_start, body_end)``."""
    if pos >= end:
        raise AudioChunkError("malformed mp4 (truncated esds descriptor)")
    tag = buf[pos]
    pos += 1
    length = 0
    for _ in range(4):
        if pos >= end:
            raise AudioChunkError("malformed mp4 (truncated esds length)")
        byte = buf[pos]
        pos += 1
        length = (length << 7) | (byte & 0x7F)
        if not byte & 0x80:
            break
    if pos + length > end:
        raise AudioChunkError("malformed mp4 (esds descriptor overruns box)")
    return tag, pos, pos + length


def _parse_esds_audio_specific_config(buf: bytes, start: int, end: int) -> bytes:
    tag, pos, body_end = _read_descriptor(buf, start, end)
    if tag != 0x03:  # ES_Descriptor
        raise AudioChunkError("malformed mp4 (esds missing ES descriptor)")
    if pos + 3 > body_end:
        raise AudioChunkError("malformed mp4 (truncated ES descriptor)")
    flags = buf[pos + 2]
    pos += 3  # ES_ID (2) + flags (1)
    if flags & 0x80:  # streamDependenceFlag -> dependsOn_ES_ID
        pos += 2
    if flags & 0x40:  # URL_Flag -> URLlength + URLstring
        pos += 1 + buf[pos]
    if flags & 0x20:  # OCRstreamFlag -> OCR_ES_Id
        pos += 2
    tag, pos, dec_end = _read_descriptor(buf, pos, body_end)
    if tag != 0x04:  # DecoderConfigDescriptor
        raise AudioChunkError("malformed mp4 (esds missing decoder config)")
    pos += 13  # objectType(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
    tag, pos, asc_end = _read_descriptor(buf, pos, dec_end)
    if tag != 0x05 or asc_end - pos < 2:  # DecSpecificInfo = AudioSpecificConfig
        raise AudioChunkError("malformed mp4 (esds missing AudioSpecificConfig)")
    return buf[pos:asc_end]


def _parse_audio_specific_config(asc: bytes) -> _AacConfig:
    object_type = (asc[0] >> 3) & 0x1F
    sfi = ((asc[0] & 0x07) << 1) | (asc[1] >> 7)
    channels = (asc[1] >> 3) & 0x0F
    # ADTS profile is a 2-bit field (object_type - 1) — only Main/LC/SSR/LTP fit;
    # recorders emit AAC-LC (2). sfi 15 = explicit frequency (no table index).
    if not 1 <= object_type <= 4:
        raise AudioChunkError("unsupported aac object type for adts")
    if sfi >= 13:
        raise AudioChunkError("unsupported aac sampling frequency index")
    if not 1 <= channels <= 7:
        raise AudioChunkError("unsupported aac channel configuration")
    return _AacConfig(
        object_type=object_type, sampling_frequency_index=sfi, channel_config=channels
    )


def _parse_stts(buf: bytes, start: int, end: int) -> list[int]:
    (entry_count,) = struct.unpack(">I", buf[start + 4 : start + 8])
    pos = start + 8
    if pos + entry_count * 8 > end:
        raise AudioChunkError("malformed mp4 (truncated stts)")
    deltas: list[int] = []
    for _ in range(entry_count):
        count, delta = struct.unpack(">II", buf[pos : pos + 8])
        pos += 8
        if delta <= 0 or len(deltas) + count > _MAX_FRAMES:
            raise AudioChunkError("malformed mp4 (implausible stts)")
        deltas.extend([delta] * count)
    if not deltas:
        raise AudioChunkError("malformed mp4 (empty stts)")
    return deltas


def _parse_stsz(buf: bytes, start: int, end: int) -> list[int]:
    sample_size, sample_count = struct.unpack(">II", buf[start + 4 : start + 12])
    if sample_count == 0 or sample_count > _MAX_FRAMES:
        raise AudioChunkError("malformed mp4 (implausible stsz)")
    if sample_size != 0:
        return [sample_size] * sample_count
    pos = start + 12
    if pos + sample_count * 4 > end:
        raise AudioChunkError("malformed mp4 (truncated stsz)")
    return list(struct.unpack(f">{sample_count}I", buf[pos : pos + sample_count * 4]))


def _parse_stsc(buf: bytes, start: int, end: int) -> list[tuple[int, int]]:
    (entry_count,) = struct.unpack(">I", buf[start + 4 : start + 8])
    pos = start + 8
    if entry_count == 0 or pos + entry_count * 12 > end:
        raise AudioChunkError("malformed mp4 (truncated stsc)")
    entries: list[tuple[int, int]] = []
    for _ in range(entry_count):
        first_chunk, samples_per_chunk, _desc = struct.unpack(">III", buf[pos : pos + 12])
        pos += 12
        if first_chunk <= 0 or samples_per_chunk <= 0:
            raise AudioChunkError("malformed mp4 (implausible stsc)")
        entries.append((first_chunk, samples_per_chunk))
    return entries


def _parse_chunk_offsets(buf: bytes, stbl: tuple[int, int]) -> list[int]:
    stco = _find_box(buf, *stbl, b"stco")
    if stco is not None:
        start, end = stco
        (count,) = struct.unpack(">I", buf[start + 4 : start + 8])
        pos = start + 8
        if pos + count * 4 > end:
            raise AudioChunkError("malformed mp4 (truncated stco)")
        return list(struct.unpack(f">{count}I", buf[pos : pos + count * 4]))
    co64 = _find_box(buf, *stbl, b"co64")
    if co64 is not None:
        start, end = co64
        (count,) = struct.unpack(">I", buf[start + 4 : start + 8])
        pos = start + 8
        if pos + count * 8 > end:
            raise AudioChunkError("malformed mp4 (truncated co64)")
        return list(struct.unpack(f">{count}Q", buf[pos : pos + count * 8]))
    # No chunk-offset table at all => fragmented MP4 (moof) or malformed — the
    # ADR-0029 recorder writes plain non-fragmented MP4; fail closed.
    raise AudioChunkError("malformed mp4 (no stco/co64 — fragmented mp4 unsupported)")


def _sample_file_ranges(
    file_len: int,
    sizes: list[int],
    stsc_entries: list[tuple[int, int]],
    chunk_offsets: list[int],
) -> list[tuple[int, int]]:
    """Expand stsc/stco/stsz into per-sample ``(file_offset, size)`` ranges."""
    ranges: list[tuple[int, int]] = []
    n_samples = len(sizes)
    chunk_count = len(chunk_offsets)
    sample = 0
    for i, (first_chunk, samples_per_chunk) in enumerate(stsc_entries):
        last_chunk = (
            stsc_entries[i + 1][0] - 1 if i + 1 < len(stsc_entries) else chunk_count
        )
        if first_chunk > chunk_count:
            raise AudioChunkError("malformed mp4 (stsc chunk out of range)")
        for chunk in range(first_chunk, last_chunk + 1):
            offset = chunk_offsets[chunk - 1]
            for _ in range(samples_per_chunk):
                if sample >= n_samples:
                    break
                size = sizes[sample]
                if size <= 0 or offset + size > file_len:
                    raise AudioChunkError("malformed mp4 (sample outside file bounds)")
                ranges.append((offset, size))
                offset += size
                sample += 1
    if sample != n_samples:
        raise AudioChunkError("malformed mp4 (stsc/stco cover fewer samples than stsz)")
    return ranges
