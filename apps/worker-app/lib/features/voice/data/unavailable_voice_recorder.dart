import '../../../core/error/failure.dart';
import '../domain/voice_models.dart';
import '../domain/voice_recorder.dart';

/// A fail-closed [VoiceRecorder] used while voice capture is backend-blocked.
///
/// A2's record→upload→transcribe leg cannot complete end-to-end: there is NO
/// backend route to turn a recorded clip into a `storage_path` (see A2-storage
/// MISSING). Rather than ship the `record` plugin (whose desktop federated impl
/// also breaks the build via a transitive version skew) for a capability that
/// can't work, the mic seam degrades honestly: permission is never granted and
/// starting a recording throws [VoiceUnavailableFailure] ("Voice note abhi
/// available nahi hai. Type karke bhejein."). Swap this for a real recorder once
/// the storage-upload + transcript routes land.
class UnavailableVoiceRecorder implements VoiceRecorder {
  const UnavailableVoiceRecorder();

  @override
  Future<bool> ensurePermission() async => false;

  @override
  Future<void> start() async => throw const VoiceUnavailableFailure();

  @override
  Future<RecordedClip?> stop() async => null;

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}
}
