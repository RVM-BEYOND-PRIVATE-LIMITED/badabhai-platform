import 'package:equatable/equatable.dart';

/// A recorded audio clip on disk, awaiting upload.
///
/// PII NOTE: the transcript of a voice note may contain personal detail, but the
/// clip itself is only referenced by an on-device [path] + [durationSeconds]
/// here — no audio bytes, no transcript, no worker identity live in this value.
class RecordedClip extends Equatable {
  const RecordedClip({required this.path, required this.durationSeconds});

  /// On-device file path of the recording. Never sent to the API or logged
  /// (the API needs a server-side `storage_path`, which is the blocked leg).
  final String path;

  /// Clip length in seconds. Bounded to (0, 120] by the recorder + API contract.
  final int durationSeconds;

  @override
  List<Object?> get props => <Object?>[path, durationSeconds];
}
