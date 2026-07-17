"""D-2 audio segmentation tests (``app.audio_chunk``) — pure unit, no network.

Splits SYNTHETIC-but-REAL containers (``tests/audio_fixtures.py`` builds actual
ISO BMFF / RIFF bytes), so the MP4 sample-table parser is exercised for real.

Covers: boundaries (every segment strictly under the provider limit), ordering +
completeness (no frame lost, none duplicated, original order preserved), output
format (ADTS for m4a, RIFF for wav), and fail-closed rejection of unsupported or
malformed containers.
"""

import struct

import pytest
from audio_fixtures import AAC_FRAME_SECONDS, build_m4a, build_wav

from app.audio_chunk import AudioChunkError, split_audio
from app.stt import SARVAM_CHUNK_MAX_SECONDS, SARVAM_SYNC_MAX_SECONDS

# --- ADTS helpers -----------------------------------------------------------

_ADTS_HEADER_LEN = 7


def _iter_adts_frames(data: bytes):
    """Yield each raw AAC payload from an ADTS stream, validating the syncword."""
    pos = 0
    while pos < len(data):
        assert data[pos] == 0xFF and (data[pos + 1] & 0xF0) == 0xF0, "bad ADTS syncword"
        frame_len = ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | (data[pos + 5] >> 5)
        yield data[pos + _ADTS_HEADER_LEN : pos + frame_len]
        pos += frame_len


def _adts_first_header(data: bytes) -> dict:
    profile = (data[2] >> 6) & 0x03
    sfi = (data[2] >> 2) & 0x0F
    channels = ((data[2] & 0x01) << 2) | ((data[3] >> 6) & 0x03)
    return {"profile": profile, "sfi": sfi, "channels": channels}


# --- m4a: boundaries --------------------------------------------------------

def test_m4a_45s_splits_into_two_segments_each_under_the_sync_limit():
    # 45s @ 64ms/frame = 704 frames. ceil(45/29.5) = 2 balanced ~22.5s windows.
    audio, _frames = build_m4a(704)
    segments = split_audio(audio, "voice-notes/w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)

    assert len(segments) == 2
    for seg in segments:
        assert seg.duration_seconds < SARVAM_SYNC_MAX_SECONDS
    assert sum(s.duration_seconds for s in segments) == pytest.approx(704 * AAC_FRAME_SECONDS)


def test_m4a_120s_platform_max_splits_into_five_segments_under_the_limit():
    # The D-2 headline case: MAX_VOICE_NOTE_SECONDS. 120s = 1875 frames;
    # ceil(120/29.5) = 5 windows of ~24s — the documented chunk count.
    audio, _frames = build_m4a(1875)
    segments = split_audio(audio, "voice-notes/w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)

    assert len(segments) == 5
    for seg in segments:
        assert 0 < seg.duration_seconds < SARVAM_SYNC_MAX_SECONDS
    assert sum(s.duration_seconds for s in segments) == pytest.approx(1875 * AAC_FRAME_SECONDS)


def test_m4a_under_the_limit_stays_one_segment():
    audio, frames = build_m4a(100)  # 6.4s
    segments = split_audio(audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    assert len(segments) == 1
    assert list(_iter_adts_frames(segments[0].data)) == frames


def test_m4a_never_emits_an_empty_segment():
    # A duration barely over one window must not produce a degenerate empty tail.
    audio, _frames = build_m4a(465)  # 29.76s -> just over one 29.5s window
    segments = split_audio(audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    assert len(segments) == 2
    for seg in segments:
        assert seg.duration_seconds > 0
        assert len(seg.data) > 0


# --- m4a: ordering + completeness -------------------------------------------

def test_m4a_segments_are_ordered_and_lose_no_frames():
    audio, frames = build_m4a(704)
    segments = split_audio(audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)

    # index is dense + ascending -> concatenation order is deterministic.
    assert [s.index for s in segments] == list(range(len(segments)))

    # Every original AAC frame appears EXACTLY once, in the original order.
    recovered = [f for seg in segments for f in _iter_adts_frames(seg.data)]
    assert recovered == frames


def test_m4a_split_is_deterministic():
    audio, _frames = build_m4a(1875)
    a = split_audio(audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    b = split_audio(audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    assert [(s.index, s.data, s.duration_seconds) for s in a] == [
        (s.index, s.data, s.duration_seconds) for s in b
    ]


def test_m4a_co64_offsets_parse_identically_to_stco():
    stco_audio, frames = build_m4a(704)
    co64_audio, _ = build_m4a(704, use_co64=True)
    stco_segments = split_audio(stco_audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    co64_segments = split_audio(co64_audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    assert [f for s in co64_segments for f in _iter_adts_frames(s.data)] == frames
    assert [s.duration_seconds for s in co64_segments] == [
        s.duration_seconds for s in stco_segments
    ]


# --- m4a: output format -----------------------------------------------------

def test_m4a_segments_are_adts_aac_with_the_source_codec_config():
    audio, _frames = build_m4a(704)
    segments = split_audio(audio, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)

    for i, seg in enumerate(segments):
        # audio/aac is already in stt._CONTENT_TYPES -> a valid multipart upload.
        assert seg.content_type == "audio/aac"
        assert seg.filename == f"chunk_{i:02d}.aac"
        assert seg.data[:2] == b"\xff\xf1"  # MPEG-4, layer 00, no CRC
        header = _adts_first_header(seg.data)
        assert header["profile"] == 1  # AAC-LC (object_type 2) - 1
        assert header["sfi"] == 8  # 16 kHz — carried from the source ASC
        assert header["channels"] == 1  # mono — carried from the source ASC


def test_m4a_mp4_extension_is_accepted_like_m4a():
    audio, frames = build_m4a(100)
    segments = split_audio(audio, "w/x.mp4", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    assert list(_iter_adts_frames(segments[0].data)) == frames


# --- wav --------------------------------------------------------------------

def test_wav_45s_splits_into_two_segments_under_the_limit():
    audio = build_wav(45.0)
    segments = split_audio(audio, "w/x.wav", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)

    assert len(segments) == 2
    for i, seg in enumerate(segments):
        assert seg.index == i
        assert seg.content_type == "audio/wav"
        assert seg.data[:4] == b"RIFF" and seg.data[8:12] == b"WAVE"
        assert seg.duration_seconds < SARVAM_SYNC_MAX_SECONDS
    assert sum(s.duration_seconds for s in segments) == pytest.approx(45.0)


def test_wav_segments_carry_every_pcm_byte_exactly_once_in_order():
    audio = build_wav(45.0)
    segments = split_audio(audio, "w/x.wav", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    # Strip each rebuilt 44-byte header; the concatenated bodies must equal the source data.
    bodies = b"".join(seg.data[44:] for seg in segments)
    assert bodies == audio[44:]


def test_wav_segment_header_declares_its_own_body_length():
    audio = build_wav(45.0)
    segments = split_audio(audio, "w/x.wav", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)
    for seg in segments:
        (declared,) = struct.unpack("<I", seg.data[40:44])
        assert declared == len(seg.data) - 44  # a truthful, self-contained header


# --- fail closed ------------------------------------------------------------

@pytest.mark.parametrize("path", ["w/x.mp3", "w/x.ogg", "w/x.opus", "w/x.webm", "w/x", "w/x.amr"])
def test_unsupported_containers_raise(path):
    # These cannot be split without a decoder, and the ADR-0029 seam never stores
    # them — fail closed rather than guess.
    with pytest.raises(AudioChunkError):
        split_audio(b"\x00" * 4096, path, max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)


def test_malformed_wav_raises():
    with pytest.raises(AudioChunkError):
        split_audio(b"RIFFfakeaudio", "w/x.wav", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)


def test_m4a_without_moov_raises():
    with pytest.raises(AudioChunkError):
        split_audio(b"\x00\x00\x00\x08ftyp", "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)


def test_truncated_m4a_raises():
    audio, _frames = build_m4a(100)
    with pytest.raises(AudioChunkError):
        split_audio(audio[: len(audio) // 2], "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)


def test_fragmented_m4a_without_chunk_offsets_raises():
    # Strip the stco table -> a fragmented/malformed file. Must fail closed, not
    # silently transcribe a partial note.
    audio, _frames = build_m4a(100)
    broken = audio.replace(b"stco", b"XXXX")
    with pytest.raises(AudioChunkError):
        split_audio(broken, "w/x.m4a", max_chunk_seconds=SARVAM_CHUNK_MAX_SECONDS)


def test_non_positive_max_chunk_seconds_raises():
    audio, _frames = build_m4a(100)
    with pytest.raises(AudioChunkError):
        split_audio(audio, "w/x.m4a", max_chunk_seconds=0)
