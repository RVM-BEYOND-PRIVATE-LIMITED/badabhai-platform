import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
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

/// A recorder that hands back a preset clip on [stop] and tracks whether the
/// mic was released.
class _FakeRecorder implements VoiceRecorder {
  _FakeRecorder(this._clip);
  final RecordedClip? _clip;

  bool stopCalled = false;

  @override
  Future<bool> ensurePermission() async => true;
  @override
  Future<void> start() async {}
  @override
  Future<RecordedClip?> stop() async {
    stopCalled = true;
    return _clip;
  }

  @override
  Future<void> cancel() async {}
  @override
  Future<void> dispose() async {}
}

class _FakeUploader implements VoiceStorageUploader {
  String? seenAuthToken;

  @override
  Future<String> upload(RecordedClip clip, {required String authToken}) async {
    seenAuthToken = authToken;
    return 'voice-notes/w1/clip.m4a';
  }
}

class _FakeResolver implements VoiceTranscriptResolver {
  String? seenAuthToken;

  @override
  Future<String> resolve(AiJob job, {required String authToken}) async {
    seenAuthToken = authToken;
    return 'CNC machine par 4 saal ka anubhav.';
  }
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
    final _FakeUploader uploader = _FakeUploader();
    final _FakeResolver resolver = _FakeResolver();
    final VoiceNoteRepositoryImpl repo = VoiceNoteRepositoryImpl(
      recorder: _FakeRecorder(
          const RecordedClip(path: '/tmp/clip.m4a', durationSeconds: 12)),
      uploader: uploader,
      resolver: resolver,
      api: api,
      chat: chat,
      session: _session(),
    );

    final VoiceNoteOutcome outcome = await repo.stopRecordingAndTranscribe();

    expect(outcome.reply, 'bhai reply');
    expect(outcome.transcript, 'CNC machine par 4 saal ka anubhav.');
    // Bearer + session id are token-derived, never widget-supplied — and the
    // SAME bearer rides through both route-less legs.
    expect(uploader.seenAuthToken, 'tok');
    expect(resolver.seenAuthToken, 'tok');
    verify(() => api.uploadVoiceNote(
          authToken: 'tok',
          sessionId: 'sess-1',
          storagePath: 'voice-notes/w1/clip.m4a',
          durationSeconds: 12,
        )).called(1);
    verify(() => api.transcribeVoiceNote(authToken: 'tok', voiceNoteId: 'vn1'))
        .called(1);
    // The transcript is merged in exactly like a typed chat message — the only
    // text on the wire is the transcript, no raw phone/name.
    verify(() => chat.sendMessage('CNC machine par 4 saal ka anubhav.'))
        .called(1);
  });

  test(
      'REAL uploader: a 503 from /voice/upload-url fails closed with '
      'VoiceUnavailableFailure — no bytes leave, nothing is registered',
      () async {
    when(() => api.requestVoiceUploadUrl(authToken: any(named: 'authToken')))
        .thenThrow(ApiException(503, 'voice uploads not enabled'));
    final VoiceNoteRepositoryImpl repo = VoiceNoteRepositoryImpl(
      recorder: _FakeRecorder(
          const RecordedClip(path: '/tmp/clip.m4a', durationSeconds: 12)),
      uploader: RealVoiceStorageUploader(
        api: api,
        // Any PUT would be a privacy bug — fail the test loudly.
        client: MockClient((http.Request req) async =>
            fail('no bytes may leave the device on a 503')),
      ),
      resolver: _FakeResolver(),
      api: api,
      chat: chat,
      session: _session(),
    );

    await expectLater(
      repo.stopRecordingAndTranscribe(),
      throwsA(isA<VoiceUnavailableFailure>()),
    );
    // Nothing was registered / transcribed / merged.
    verifyNever(() => api.uploadVoiceNote(
          authToken: any(named: 'authToken'),
          sessionId: any(named: 'sessionId'),
          storagePath: any(named: 'storagePath'),
          durationSeconds: any(named: 'durationSeconds'),
        ));
    verifyNever(() => chat.sendMessage(any()));
  });

  test(
      'REGRESSION (mic release): ensureSession throws → recorder.stop() was '
      'still called FIRST and the orphaned clip file is deleted', () async {
    // A real temp file standing in for the recorded clip. Named OUTSIDE the
    // recorder's bb-voice-* pattern so no concurrent sweep can touch it.
    final File clipFile = File(
        '${Directory.systemTemp.path}${Platform.pathSeparator}bb-repo-clip-'
        '${DateTime.now().microsecondsSinceEpoch}.m4a');
    await clipFile.writeAsBytes(<int>[1, 2, 3]);
    addTearDown(() async {
      if (await clipFile.exists()) await clipFile.delete();
    });

    when(() => chat.ensureSession()).thenThrow(const NetworkFailure());
    final _FakeRecorder recorder = _FakeRecorder(
        RecordedClip(path: clipFile.path, durationSeconds: 12));
    final VoiceNoteRepositoryImpl repo = VoiceNoteRepositoryImpl(
      recorder: recorder,
      uploader: _FakeUploader(),
      resolver: _FakeResolver(),
      api: api,
      chat: chat,
      session: _session(),
    );

    await expectLater(
      repo.stopRecordingAndTranscribe(),
      throwsA(isA<NetworkFailure>()),
    );
    // The mic was released even though the session leg failed…
    expect(recorder.stopCalled, isTrue);
    // …and the clip that never reached the uploader did not linger on disk.
    expect(await clipFile.exists(), isFalse);
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

  test('a null clip from the recorder fails closed with honest copy', () async {
    final VoiceNoteRepositoryImpl repo = VoiceNoteRepositoryImpl(
      recorder: _FakeRecorder(null),
      uploader: _FakeUploader(),
      resolver: _FakeResolver(),
      api: api,
      chat: chat,
      session: _session(),
    );

    await expectLater(
      repo.stopRecordingAndTranscribe(),
      throwsA(isA<VoiceUnavailableFailure>()),
    );
    verifyNever(() => chat.sendMessage(any()));
  });
}
