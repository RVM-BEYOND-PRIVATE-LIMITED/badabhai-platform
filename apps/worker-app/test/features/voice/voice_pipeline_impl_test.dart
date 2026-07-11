import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/data/voice_pipeline_impl.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';

class MockApiClient extends Mock implements ApiClient {}

const AiJob _completedJob = AiJob(
  id: 'job-9',
  jobType: 'transcription',
  status: 'completed',
  profileId: null,
  errorMessage: null,
  voiceNoteId: 'vn1',
);

void main() {
  late MockApiClient api;

  setUp(() => api = MockApiClient());

  group('RealVoiceStorageUploader', () {
    late File clipFile;

    setUp(() async {
      clipFile = File(
          '${Directory.systemTemp.path}${Platform.pathSeparator}bb-test-clip-'
          '${DateTime.now().microsecondsSinceEpoch}.m4a');
      await clipFile.writeAsBytes(<int>[1, 2, 3, 4]);
    });

    tearDown(() async {
      if (await clipFile.exists()) await clipFile.delete();
    });

    test(
        'happy path: mints the slot, PUTs the bytes with audio/mp4, deletes '
        'the temp file, and returns the MINTED storage_path', () async {
      when(() => api.requestVoiceUploadUrl(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const VoiceUploadTicket(
                storagePath: 'voice-notes/w1/abc.m4a',
                uploadUrl: 'https://storage.test/signed-slot',
                expiresInSeconds: 7200,
              ));
      late http.Request captured;
      final RealVoiceStorageUploader uploader = RealVoiceStorageUploader(
        api: api,
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response('', 200);
        }),
      );

      final String path = await uploader.upload(
        RecordedClip(path: clipFile.path, durationSeconds: 12),
        authToken: 'tok',
      );

      expect(path, 'voice-notes/w1/abc.m4a');
      expect(captured.method, 'PUT');
      expect(captured.url.toString(), 'https://storage.test/signed-slot');
      expect(captured.headers['content-type'], startsWith('audio/mp4'));
      expect(captured.bodyBytes, Uint8List.fromList(<int>[1, 2, 3, 4]));
      verify(() => api.requestVoiceUploadUrl(authToken: 'tok')).called(1);
      // Uploaded — the on-device temp copy is gone.
      expect(await clipFile.exists(), isFalse);
    });

    test(
        '503 on upload-url → VoiceUnavailableFailure, no PUT, and the temp '
        'clip is DELETED (raw audio never outlives the attempt)', () async {
      when(() => api.requestVoiceUploadUrl(authToken: any(named: 'authToken')))
          .thenThrow(ApiException(503, 'not enabled'));
      final RealVoiceStorageUploader uploader = RealVoiceStorageUploader(
        api: api,
        client: MockClient((http.Request req) async =>
            fail('no bytes may leave the device on a 503')),
      );

      await expectLater(
        uploader.upload(
          RecordedClip(path: clipFile.path, durationSeconds: 12),
          authToken: 'tok',
        ),
        throwsA(isA<VoiceUnavailableFailure>()),
      );
      expect(await clipFile.exists(), isFalse);
    });

    test('non-503 mint failure rethrows the ApiException unchanged', () async {
      when(() => api.requestVoiceUploadUrl(authToken: any(named: 'authToken')))
          .thenThrow(ApiException(401, 'unauthorized'));
      final RealVoiceStorageUploader uploader = RealVoiceStorageUploader(
        api: api,
        client: MockClient((http.Request req) async => http.Response('', 200)),
      );

      await expectLater(
        uploader.upload(
          RecordedClip(path: clipFile.path, durationSeconds: 12),
          authToken: 'tok',
        ),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 401)),
      );
    });

    test(
        'a failed PUT throws ApiException(status) and the temp clip is '
        'DELETED (failure must not leave raw audio behind)', () async {
      when(() => api.requestVoiceUploadUrl(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const VoiceUploadTicket(
                storagePath: 'voice-notes/w1/abc.m4a',
                uploadUrl: 'https://storage.test/signed-slot',
                expiresInSeconds: 7200,
              ));
      final RealVoiceStorageUploader uploader = RealVoiceStorageUploader(
        api: api,
        client:
            MockClient((http.Request req) async => http.Response('nope', 500)),
      );

      await expectLater(
        uploader.upload(
          RecordedClip(path: clipFile.path, durationSeconds: 12),
          authToken: 'tok',
        ),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 500)),
      );
      expect(await clipFile.exists(), isFalse);
    });

    test(
        'a HANGING PUT times out honestly: ApiException(408), never a forever '
        'spinner; the temp clip is deleted', () async {
      when(() => api.requestVoiceUploadUrl(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const VoiceUploadTicket(
                storagePath: 'voice-notes/w1/abc.m4a',
                uploadUrl: 'https://storage.test/signed-slot',
                expiresInSeconds: 7200,
              ));
      final RealVoiceStorageUploader uploader = RealVoiceStorageUploader(
        api: api,
        // A stalled socket: the response future never completes.
        client: MockClient(
            (http.Request req) => Completer<http.Response>().future),
        putTimeout: const Duration(milliseconds: 50),
      );

      await expectLater(
        uploader.upload(
          RecordedClip(path: clipFile.path, durationSeconds: 12),
          authToken: 'tok',
        ),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 408)),
      );
      expect(await clipFile.exists(), isFalse);
    });
  });

  group('RealVoiceTranscriptResolver', () {
    test('prefers transcript_text over transcript_english', () async {
      when(() => api.fetchVoiceNote(
            authToken: any(named: 'authToken'),
            voiceNoteId: any(named: 'voiceNoteId'),
          )).thenAnswer((_) async => const VoiceNoteDetail(
            voiceNoteId: 'vn1',
            durationSeconds: 12,
            transcriptText: 'CNC par 4 saal.',
            transcriptEnglish: '4 years on CNC.',
            transcriptConfidence: 0.9,
          ));

      final String text = await RealVoiceTranscriptResolver(api)
          .resolve(_completedJob, authToken: 'tok');

      expect(text, 'CNC par 4 saal.');
      verify(() => api.fetchVoiceNote(authToken: 'tok', voiceNoteId: 'vn1'))
          .called(1);
    });

    test('falls back to transcript_english when text is empty/blank', () async {
      when(() => api.fetchVoiceNote(
            authToken: any(named: 'authToken'),
            voiceNoteId: any(named: 'voiceNoteId'),
          )).thenAnswer((_) async => const VoiceNoteDetail(
            voiceNoteId: 'vn1',
            durationSeconds: 12,
            transcriptText: '   ',
            transcriptEnglish: '4 years on CNC.',
            transcriptConfidence: 0.9,
          ));

      final String text = await RealVoiceTranscriptResolver(api)
          .resolve(_completedJob, authToken: 'tok');

      expect(text, '4 years on CNC.');
    });

    test('both transcripts missing → VoiceUnavailableFailure (honest copy)',
        () async {
      when(() => api.fetchVoiceNote(
            authToken: any(named: 'authToken'),
            voiceNoteId: any(named: 'voiceNoteId'),
          )).thenAnswer((_) async => const VoiceNoteDetail(
            voiceNoteId: 'vn1',
            durationSeconds: 12,
            transcriptText: null,
            transcriptEnglish: null,
            transcriptConfidence: null,
          ));

      await expectLater(
        RealVoiceTranscriptResolver(api)
            .resolve(_completedJob, authToken: 'tok'),
        throwsA(isA<VoiceUnavailableFailure>()),
      );
    });

    test('a job without voice_note_id fails closed WITHOUT a fetch', () async {
      const AiJob noRef = AiJob(
        id: 'job-9',
        jobType: 'transcription',
        status: 'completed',
        profileId: null,
        errorMessage: null,
      );

      await expectLater(
        RealVoiceTranscriptResolver(api).resolve(noRef, authToken: 'tok'),
        throwsA(isA<VoiceUnavailableFailure>()),
      );
      verifyNever(() => api.fetchVoiceNote(
            authToken: any(named: 'authToken'),
            voiceNoteId: any(named: 'voiceNoteId'),
          ));
    });
  });

  test(
      'MOCK parity: MockVoiceTranscriptResolver text matches '
      'MockApiClient.fetchVoiceNote transcript_text', () async {
    expect(
      await const MockVoiceTranscriptResolver()
          .resolve(_completedJob, authToken: 'mock'),
      MockVoiceTranscriptResolver.cannedTranscript,
    );
  });
}
