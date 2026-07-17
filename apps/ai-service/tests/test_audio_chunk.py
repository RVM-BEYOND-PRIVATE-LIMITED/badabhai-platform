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
from audio_fixtures import AAC_FRAME_SECONDS, build_crafted_m4a, build_m4a, build_wav

from app.audio_chunk import AudioChunkError, split_audio
from app.stt import (
    MAX_VOICE_NOTE_SECONDS,
    SARVAM_CHUNK_MAX_SECONDS,
    SARVAM_SYNC_MAX_SECONDS,
)


def _split(audio: bytes, path: str, **overrides):
    """split_audio with the PRODUCTION bounds (what stt.py passes), so these
    tests exercise the real configuration unless a case overrides one."""
    kwargs = {
        "max_chunk_seconds": SARVAM_CHUNK_MAX_SECONDS,
        "max_total_seconds": MAX_VOICE_NOTE_SECONDS,
    }
    kwargs.update(overrides)
    return split_audio(audio, path, **kwargs)


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
    segments = _split(audio, "voice-notes/w/x.m4a")

    assert len(segments) == 2
    for seg in segments:
        assert seg.duration_seconds < SARVAM_SYNC_MAX_SECONDS
    assert sum(s.duration_seconds for s in segments) == pytest.approx(704 * AAC_FRAME_SECONDS)


def test_m4a_120s_platform_max_splits_into_five_segments_under_the_limit():
    # The D-2 headline case: MAX_VOICE_NOTE_SECONDS. 120s = 1875 frames;
    # ceil(120/29.5) = 5 windows of ~24s — the documented chunk count.
    audio, _frames = build_m4a(1875)
    segments = _split(audio, "voice-notes/w/x.m4a")

    assert len(segments) == 5
    for seg in segments:
        assert 0 < seg.duration_seconds < SARVAM_SYNC_MAX_SECONDS
    assert sum(s.duration_seconds for s in segments) == pytest.approx(1875 * AAC_FRAME_SECONDS)


def test_m4a_under_the_limit_stays_one_segment():
    audio, frames = build_m4a(100)  # 6.4s
    segments = _split(audio, "w/x.m4a")
    assert len(segments) == 1
    assert list(_iter_adts_frames(segments[0].data)) == frames


def test_m4a_never_emits_an_empty_segment():
    # A duration barely over one window must not produce a degenerate empty tail.
    audio, _frames = build_m4a(465)  # 29.76s -> just over one 29.5s window
    segments = _split(audio, "w/x.m4a")
    assert len(segments) == 2
    for seg in segments:
        assert seg.duration_seconds > 0
        assert len(seg.data) > 0


# --- m4a: ordering + completeness -------------------------------------------

def test_m4a_segments_are_ordered_and_lose_no_frames():
    audio, frames = build_m4a(704)
    segments = _split(audio, "w/x.m4a")

    # index is dense + ascending -> concatenation order is deterministic.
    assert [s.index for s in segments] == list(range(len(segments)))

    # Every original AAC frame appears EXACTLY once, in the original order.
    recovered = [f for seg in segments for f in _iter_adts_frames(seg.data)]
    assert recovered == frames


def test_m4a_split_is_deterministic():
    audio, _frames = build_m4a(1875)
    a = _split(audio, "w/x.m4a")
    b = _split(audio, "w/x.m4a")
    assert [(s.index, s.data, s.duration_seconds) for s in a] == [
        (s.index, s.data, s.duration_seconds) for s in b
    ]


def test_m4a_co64_offsets_parse_identically_to_stco():
    stco_audio, frames = build_m4a(704)
    co64_audio, _ = build_m4a(704, use_co64=True)
    stco_segments = _split(stco_audio, "w/x.m4a")
    co64_segments = _split(co64_audio, "w/x.m4a")
    assert [f for s in co64_segments for f in _iter_adts_frames(s.data)] == frames
    assert [s.duration_seconds for s in co64_segments] == [
        s.duration_seconds for s in stco_segments
    ]


# --- m4a: output format -----------------------------------------------------

def test_m4a_segments_are_adts_aac_with_the_source_codec_config():
    audio, _frames = build_m4a(704)
    segments = _split(audio, "w/x.m4a")

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
    segments = _split(audio, "w/x.mp4")
    assert list(_iter_adts_frames(segments[0].data)) == frames


# --- wav --------------------------------------------------------------------

def test_wav_45s_splits_into_two_segments_under_the_limit():
    audio = build_wav(45.0)
    segments = _split(audio, "w/x.wav")

    assert len(segments) == 2
    for i, seg in enumerate(segments):
        assert seg.index == i
        assert seg.content_type == "audio/wav"
        assert seg.data[:4] == b"RIFF" and seg.data[8:12] == b"WAVE"
        assert seg.duration_seconds < SARVAM_SYNC_MAX_SECONDS
    assert sum(s.duration_seconds for s in segments) == pytest.approx(45.0)


def test_wav_segments_carry_every_pcm_byte_exactly_once_in_order():
    audio = build_wav(45.0)
    segments = _split(audio, "w/x.wav")
    # Strip each rebuilt 44-byte header; the concatenated bodies must equal the source data.
    bodies = b"".join(seg.data[44:] for seg in segments)
    assert bodies == audio[44:]


def test_wav_segment_header_declares_its_own_body_length():
    audio = build_wav(45.0)
    segments = _split(audio, "w/x.wav")
    for seg in segments:
        (declared,) = struct.unpack("<I", seg.data[40:44])
        assert declared == len(seg.data) - 44  # a truthful, self-contained header


# --- fail closed ------------------------------------------------------------

@pytest.mark.parametrize("path", ["w/x.mp3", "w/x.ogg", "w/x.opus", "w/x.webm", "w/x", "w/x.amr"])
def test_unsupported_containers_raise(path):
    # These cannot be split without a decoder, and the ADR-0029 seam never stores
    # them — fail closed rather than guess.
    with pytest.raises(AudioChunkError):
        _split(b"\x00" * 4096, path)


def test_malformed_wav_raises():
    with pytest.raises(AudioChunkError):
        _split(b"RIFFfakeaudio", "w/x.wav")


def test_m4a_without_moov_raises():
    with pytest.raises(AudioChunkError):
        _split(b"\x00\x00\x00\x08ftyp", "w/x.m4a")


def test_truncated_m4a_raises():
    audio, _frames = build_m4a(100)
    with pytest.raises(AudioChunkError):
        _split(audio[: len(audio) // 2], "w/x.m4a")


def test_fragmented_m4a_without_chunk_offsets_raises():
    # Strip the stco table -> a fragmented/malformed file. Must fail closed, not
    # silently transcribe a partial note.
    audio, _frames = build_m4a(100)
    broken = audio.replace(b"stco", b"XXXX")
    with pytest.raises(AudioChunkError):
        _split(broken, "w/x.m4a")


def test_non_positive_max_chunk_seconds_raises():
    audio, _frames = build_m4a(100)
    with pytest.raises(AudioChunkError):
        _split(audio, "w/x.m4a", max_chunk_seconds=0)


def test_non_positive_max_total_seconds_raises():
    audio, _frames = build_m4a(100)
    with pytest.raises(AudioChunkError):
        _split(audio, "w/x.m4a", max_total_seconds=0)


# --- H-1: the FILE's own declared duration bounds the segment count ----------
# The caller reserves budget from the CLIENT-DECLARED duration; the segment count
# comes from the FILE's tables. They are INDEPENDENT worker-controlled inputs, so
# the splitter must bound the file itself or a tiny crafted file becomes a spend
# primitive. Every case here must FAIL CLOSED before producing a single segment.

def test_crafted_tables_claiming_200000s_are_refused_not_split_into_6780_calls():
    # THE H-1 reproducer: a tiny file whose tables declare 200,000s. Pre-fix this
    # returned 6,780 segments = 6,780 Sarvam calls (~Rs 1695) against a 2-chunk
    # (Rs 0.50) reservation, blowing the per-user, daily AND cumulative caps in
    # ONE request. What matters is that ZERO segments are produced; this shape is
    # now stopped by the frame ceiling (200,000 > _MAX_AAC_FRAMES) before the
    # duration bound is even reached — either guard is a valid fail-closed.
    audio = build_crafted_m4a(frame_count=200_000, timescale=1, delta=1)
    assert len(audio) < 10_000, "the attack is a TINY file declaring a huge stream"
    with pytest.raises(AudioChunkError):
        _split(audio, "w/x.m4a")


def test_duration_bound_catches_long_frames_that_slip_under_the_frame_ceiling():
    # The frame ceiling alone is NOT enough: 1,000 frames is well under
    # _MAX_AAC_FRAMES, but at 1s/frame the file declares 1,000s => 34 provider
    # calls. Only the duration bound stops this shape, so pin it by message.
    audio = build_crafted_m4a(frame_count=1_000, timescale=1, delta=1)
    with pytest.raises(AudioChunkError, match="exceeds"):
        _split(audio, "w/x.m4a")


@pytest.mark.parametrize(
    ("frame_count", "timescale", "delta"),
    [
        (5_000, 1, 1),  # 5,000s via many 1s frames (under the frame ceiling)
        (200_000, 1, 1),  # 200,000s via a huge frame count
        (1_000, 1, 1),  # 1,000s
        (200, 1, 10),  # 2,000s via few frames with LONG deltas
        (2, 1, 1000),  # 2,000s via 2 absurd frames
    ],
)
def test_any_container_duration_over_the_cap_is_refused(frame_count, timescale, delta):
    audio = build_crafted_m4a(frame_count=frame_count, timescale=timescale, delta=delta)
    with pytest.raises(AudioChunkError):
        _split(audio, "w/x.m4a")


def test_container_duration_bound_is_independent_of_any_declared_duration():
    # split_audio never sees a "declared" duration — it derives the real one. A
    # 121s file is refused; a 119s file of the same shape splits. The bound cannot
    # be talked out of by a caller/client claim.
    over = build_crafted_m4a(frame_count=121, timescale=1, delta=1)
    under = build_crafted_m4a(frame_count=119, timescale=1, delta=1)
    with pytest.raises(AudioChunkError):
        _split(over, "w/x.m4a")
    assert len(_split(under, "w/x.m4a")) == 5  # ceil(119/29.5)


def test_honest_120s_note_is_exactly_at_the_bound_and_still_splits():
    # The bound must not cost an honest full-length note anything.
    audio, _frames = build_m4a(1875)  # exactly 120.0s
    assert len(_split(audio, "w/x.m4a")) == 5


def test_wav_over_the_duration_cap_is_refused():
    with pytest.raises(AudioChunkError, match="exceeds"):
        _split(build_wav(121.0), "w/x.wav")


# --- M-2: run-length tables must not amplify memory -------------------------

def test_stsz_declaring_millions_of_samples_from_a_tiny_file_is_refused():
    # stsz with a FIXED sample_size synthesizes the size list from the COUNT
    # alone — no per-frame bytes in the file. A ~500B input could ask for 20M
    # list entries (measured 320MB peak, ~630,000:1) before the ceiling was cut.
    audio = build_crafted_m4a(frame_count=10, declared_sample_count=20_000_000)
    with pytest.raises(AudioChunkError, match="implausible stsz"):
        _split(audio, "w/x.m4a")


def test_stts_run_length_declaring_millions_of_frames_is_refused():
    # ONE 8-byte stts entry can declare count=20,000,000.
    audio = build_crafted_m4a(frame_count=20_000_000, timescale=16000, delta=1024)
    with pytest.raises(AudioChunkError, match="implausible stts"):
        _split(audio, "w/x.m4a")


def test_the_frame_ceiling_is_bounded_and_far_above_an_honest_note():
    from app.audio_chunk import _MAX_AAC_FRAMES

    # An honest 120s note is 1,875 frames @16kHz (~5.6k @48kHz). The ceiling
    # must leave headroom without being an amplification lever.
    assert 1875 < _MAX_AAC_FRAMES <= 20_000


def test_hostile_stsz_allocates_no_memory_before_failing():
    import tracemalloc

    audio = build_crafted_m4a(frame_count=10, declared_sample_count=20_000_000)
    tracemalloc.start()
    try:
        with pytest.raises(AudioChunkError):
            _split(audio, "w/x.m4a")
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # Pre-fix this peaked at ~320MB from a 508-byte input. The guard runs BEFORE
    # the allocation, so the peak must stay in the noise (<1MB).
    assert peak < 1_000_000, f"peak {peak} bytes — the count guard allocated first"


# --- M-1: every escape must be an AudioChunkError, not a bare exception ------

def test_stsc_first_chunk_overflow_raises_audiochunkerror_not_indexerror():
    # M-1(i): `last_chunk` comes from the NEXT stsc entry's first_chunk, which the
    # old guard never validated -> IndexError escaped the documented contract.
    audio = build_crafted_m4a(frame_count=100, stsc_first_chunk=0xFFFFFFFF)
    with pytest.raises(AudioChunkError):
        _split(audio, "w/x.m4a")


def test_fewer_frames_than_windows_raises_audiochunkerror_not_indexerror():
    # M-1(ii): 2 frames of 1000s each -> n_chunks=68 > 2 frames -> the clamp went
    # negative -> non-monotonic boundaries -> IndexError. (The duration bound also
    # catches this shape now; the guard must stand on its own regardless.)
    from app.audio_chunk import _chunk_boundaries

    with pytest.raises(AudioChunkError):
        _chunk_boundaries([1000.0, 2000.0], 29.5)


def test_short_table_box_raises_audiochunkerror_not_structerror():
    # M-1(iii): a truncated stts box's header read would spill into the
    # neighbouring box and surface as struct.error at EOF.
    for cut in (9, 10, 12, 14):
        audio = build_crafted_m4a(frame_count=100, truncate_stts_to=cut)
        with pytest.raises(AudioChunkError):
            _split(audio, "w/x.m4a")


def test_no_crafted_input_escapes_as_a_non_audiochunkerror():
    # The contract: split_audio raises AudioChunkError or returns segments —
    # never a bare IndexError/struct.error. stt.py's broad except contains these
    # today, but the contract must be true on its own (one catch is all that
    # stands between the parser and a 500).
    hostile = [
        build_crafted_m4a(frame_count=200_000, timescale=1, delta=1),
        build_crafted_m4a(frame_count=10, declared_sample_count=20_000_000),
        build_crafted_m4a(frame_count=100, stsc_first_chunk=0xFFFFFFFF),
        build_crafted_m4a(frame_count=100, truncate_stts_to=10),
        build_crafted_m4a(frame_count=2, timescale=1, delta=1000),
        b"RIFFfakeaudio",
        b"\x00\x00\x00\x08ftyp",
        b"",
    ]
    for audio in hostile:
        with pytest.raises(AudioChunkError):
            _split(audio, "w/x.m4a")
