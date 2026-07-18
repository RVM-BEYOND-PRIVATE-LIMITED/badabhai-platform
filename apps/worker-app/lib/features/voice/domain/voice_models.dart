import 'package:equatable/equatable.dart';

/// A recorded audio clip on disk, awaiting upload.
///
/// PII NOTE: the transcript of a voice note may contain personal detail, but the
/// clip itself is only referenced by an on-device [path] + [durationSeconds]
/// here — no audio bytes, no transcript, no worker identity live in this value.
class RecordedClip extends Equatable {
  const RecordedClip({required this.path, required this.durationSeconds});

  /// On-device file path of the recording. Never sent to the API or logged —
  /// only the raw BYTES are PUT to the signed upload url; the server-side
  /// `storage_path` (minted by POST /voice/upload-url) crosses the wire.
  final String path;

  /// Clip length in seconds. Bounded to (0, 120] by the recorder + API contract.
  final int durationSeconds;

  @override
  List<Object?> get props => <Object?>[path, durationSeconds];
}

/// Terminal result of the voice-note pipeline: the resolved [transcript] (what
/// the worker said, merged into the chat as their message) plus bada bhai's
/// [reply]. The voice screen pops back to chat with this so both bubbles render
/// immediately without a refetch.
///
/// PII NOTE: the transcript is worker-authored content — held transiently in
/// state to display, never logged or persisted on device.
class VoiceNoteOutcome extends Equatable {
  const VoiceNoteOutcome({
    required this.transcript,
    required this.reply,
    this.extractionReady = false,
  });

  final String transcript;
  final String reply;

  /// The engine's `extraction_ready` for the chat turn this voice note produced
  /// (#421). Carried back so a worker who answers BY VOICE unlocks the
  /// "build my profile" CTA exactly like one who typed.
  final bool extractionReady;

  @override
  List<Object?> get props => <Object?>[transcript, reply, extractionReady];
}
