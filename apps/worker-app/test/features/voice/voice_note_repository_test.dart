import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/voice/data/voice_note_repository_impl.dart';
import 'package:badabhai_worker_app/features/voice/data/voice_pipeline_impl.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_pipeline.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_recorder.dart';

class MockApiClient extends Mock implements ApiClient {}

class MockChatRepository extends Mock implements ChatRepository {}

/// A recorder that hands back a preset clip on [stop].
class _FakeRecorder implements VoiceRecorder {
  _FakeRecorder(this._clip);
  final RecordedClip? _clip;

  @override
  Future<bool> ensurePermission() async => true;
  @override
  Future<void> start() async {}
  @override
  Future<RecordedClip?> stop() async => _clip;
  @override
  Future<void> cancel() async {}
  @override
  Future<void> dispose() async {}
}

class _FakeUploader implements VoiceStorageUploader {
  @override
  Future<String> upload(RecordedClip clip) async => 'mock/voice/clip.m4a';
}

class _FakeResolver implements VoiceTranscriptResolver {
  @override
  Future<String> resolve(AiJob job) async =>
      'CNC machine par 4 saal ka anubhav.';
}

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
  ..setSession('sess-1');

void main() {
  late MockApiClient api;
  late MockChatRepository chat;

  setUp(() {
    api = MockApiClient();
    chat = MockChatRepository();
    when(() => chat.ensureSession()).thenAnswer((_) async {});
    when(() => chat.sendMessage(any())).thenAnswer((_) async => 'bhai reply');
    when(() => api.uploadVoiceNote(
          authToken: any(named: 'authToken'),
          sessionId: any(named: 'sessionId'),
          storagePath: any(named: 'storagePath'),
          durationSeconds: any(named: 'durationSeconds'),
        )).thenAnswer((_) async =>
        const VoiceUploadResult(voiceNoteId: 'vn1', durationSeconds: 12));
    when(() => api.transcribeVoiceNote(
          authToken: any(named: 'authToken'),
          voiceNoteId: any(named: 'voiceNoteId'),
        )).thenAnswer(
        (_) async => const TranscribeResult(aiJobId: 'job-9', status: 'queued'));
    when(() => api.awaitAiJob(any())).thenAnswer((_) async => const AiJob(
          id: 'job-9',
          jobType: 'transcription',
          status: 'completed',
          profileId: null,
          errorMessage: null,
          voiceNoteId: 'vn1',
        ));
  });

  test(
      'pipeline: upload → transcribe → poll → resolve → merge into chat, '
      'bearer-scoped and PII-free', () async {
    final VoiceNoteRepositoryImpl repo = VoiceNoteRepositoryImpl(
      recorder: _FakeRecorder(
          const RecordedClip(path: '/tmp/clip.m4a', durationSeconds: 12)),
      uploader: _FakeUploader(),
      resolver: _FakeResolver(),
      api: api,
      chat: chat,
      session: _session(),
    );

    final String reply = await repo.stopRecordingAndTranscribe();

    expect(reply, 'bhai reply');
    // Bearer + session id are token-derived, never widget-supplied.
    verify(() => api.uploadVoiceNote(
          authToken: 'tok',
          sessionId: 'sess-1',
          storagePath: 'mock/voice/clip.m4a',
          durationSeconds: 12,
        )).called(1);
    verify(() => api.transcribeVoiceNote(authToken: 'tok', voiceNoteId: 'vn1'))
        .called(1);
    // The transcript is merged in exactly like a typed chat message — the only
    // text on the wire is the transcript, no raw phone/name.
    verify(() => chat.sendMessage('CNC machine par 4 saal ka anubhav.'))
        .called(1);
  });

  test('REAL storage leg fails closed with VoiceUnavailableFailure (no upload)',
      () async {
    final VoiceNoteRepositoryImpl repo = VoiceNoteRepositoryImpl(
      recorder: _FakeRecorder(
          const RecordedClip(path: '/tmp/clip.m4a', durationSeconds: 12)),
      uploader: const RealVoiceStorageUploader(), // the blocked leg
      resolver: const RealVoiceTranscriptResolver(),
      api: api,
      chat: chat,
      session: _session(),
    );

    await expectLater(
      repo.stopRecordingAndTranscribe(),
      throwsA(isA<VoiceUnavailableFailure>()),
    );
    // Nothing left the device: no upload/transcribe/merge happened.
    verifyNever(() => api.uploadVoiceNote(
          authToken: any(named: 'authToken'),
          sessionId: any(named: 'sessionId'),
          storagePath: any(named: 'storagePath'),
          durationSeconds: any(named: 'durationSeconds'),
        ));
    verifyNever(() => chat.sendMessage(any()));
  });

  test('missing session token fails closed (UnauthorizedFailure)', () async {
    final VoiceNoteRepositoryImpl repo = VoiceNoteRepositoryImpl(
      recorder: _FakeRecorder(
          const RecordedClip(path: '/tmp/clip.m4a', durationSeconds: 12)),
      uploader: _FakeUploader(),
      resolver: _FakeResolver(),
      api: api,
      chat: chat,
      session: SessionRepository()..setSession('sess-1'), // no token
    );

    await expectLater(
      repo.stopRecordingAndTranscribe(),
      throwsA(isA<UnauthorizedFailure>()),
    );
  });
}
