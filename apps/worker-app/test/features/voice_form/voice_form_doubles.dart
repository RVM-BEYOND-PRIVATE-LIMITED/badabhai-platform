import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_pipeline.dart';

/// Shared doubles for the voice-form cubit suites (#717).
///
/// The cubit now owns the clip → `voice_note_id` upload, so every construction of it needs a
/// registrar and a session. Both live here rather than being re-declared per file: four
/// suites drive the same cubit, and a fake that disagrees between them is how a test starts
/// passing for a reason the production path does not share.

/// Records what it was handed and returns [nextId]. Set [throws] to make the upload leg fail
/// the way a 503 (voice disabled server-side) or a stalled PUT does.
class FakeRegistrar implements VoiceNoteRegistrar {
  final List<RecordedClip> registered = <RecordedClip>[];
  final List<String> sessionIds = <String>[];
  String nextId = 'vn-test-1';
  Object? throws;

  @override
  Future<String> register(
    RecordedClip clip, {
    required String authToken,
    required String sessionId,
  }) async {
    final Object? failure = throws;
    if (failure != null) throw failure;
    registered.add(clip);
    sessionIds.add(sessionId);
    return nextId;
  }
}

/// A session with a token, which is what `_registerClip` requires before it will upload.
/// PII-free placeholders — nothing here reaches a wire in a unit test.
SessionRepository testSession() => SessionRepository()
  ..setWorker(
    phone: '+910000000000',
    workerId: 'w-test',
    sessionToken: 'tok-test',
  );
