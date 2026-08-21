// The WIRE boundary for a feedback submission.
//
// The screen context is normalized HERE and not at the call site, so every
// caller present and future gets a route PATTERN — a screen that forgets cannot
// put an identifier on the endpoint (and from there onto the `feedback.submitted`
// event, where CLAUDE.md §2 forbids one).
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/feedback/data/feedback_repository_impl.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_category.dart';

class _MockApiClient extends Mock implements ApiClient {}

void main() {
  late _MockApiClient api;
  late SessionRepository session;
  late FeedbackRepositoryImpl repo;

  setUp(() {
    api = _MockApiClient();
    session = SessionRepository()..setSessionToken('tok');
    repo = FeedbackRepositoryImpl(api, session);
    when(() => api.submitFeedback(
          authToken: any(named: 'authToken'),
          message: any(named: 'message'),
          category: any(named: 'category'),
          screen: any(named: 'screen'),
        )).thenAnswer((_) async {});
  });

  test('an id-carrying path reaches the wire as a route PATTERN', () async {
    await repo.submit(
      message: 'button kaam nahi kar raha',
      category: FeedbackCategory.problem,
      screen: '/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply',
    );

    verify(() => api.submitFeedback(
          authToken: 'tok',
          message: 'button kaam nahi kar raha',
          category: 'problem',
          screen: '/jobs/:id/apply',
        )).called(1);
  });

  test('an ordinary route reaches the wire unchanged', () async {
    await repo.submit(message: 'theek hai', screen: '/settings/notifications');
    verify(() => api.submitFeedback(
          authToken: 'tok',
          message: 'theek hai',
          category: null,
          screen: '/settings/notifications',
        )).called(1);
  });

  test('a route the contract refuses becomes null — and the message still goes',
      () async {
    // Losing a worker's typed paragraph over a telemetry value they never filled
    // in is the wrong failure direction. The server takes the identical posture.
    await repo.submit(message: 'meri baat', screen: '//evil.example/jobs');
    verify(() => api.submitFeedback(
          authToken: 'tok',
          message: 'meri baat',
          category: null,
          screen: null,
        )).called(1);
  });

  test('no route at all is simply omitted', () async {
    await repo.submit(message: 'meri baat');
    verify(() => api.submitFeedback(
          authToken: 'tok',
          message: 'meri baat',
          category: null,
          screen: null,
        )).called(1);
  });

  test('a 400 surfaces as the RECOVERABLE failure, not a generic server error',
      () async {
    when(() => api.submitFeedback(
          authToken: any(named: 'authToken'),
          message: any(named: 'message'),
          category: any(named: 'category'),
          screen: any(named: 'screen'),
        )).thenThrow(ApiException(400, 'message is too long'));

    // #1013 — a ServerFailure(400) rendered "Thodi der baad try karein", telling
    // the worker to wait for something that would fail identically forever.
    await expectLater(
      repo.submit(message: 'x'),
      throwsA(isA<InvalidRequestFailure>()),
    );
  });

  /// `screen` is a NEW key on a DTO the server declares `.strict()`. Measured
  /// against the schema deployed on origin/main today, a body carrying it comes
  /// back `400 unrecognized_keys` — and the screen renders a 400 as the
  /// PERSISTENT "change what you sent" panel, which nothing the worker types can
  /// clear. Every FAB-originated report would be unsendable until the API ships.
  ///
  /// So the optional field degrades like one, and the worker's paragraph is never
  /// the thing that is lost.
  group('an API that does not know `screen` yet', () {
    test('a 400 on the screen-carrying body retries once WITHOUT it', () async {
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(ApiException(400, "Unrecognized key(s): 'screen'"));
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
          )).thenAnswer((_) async {});

      await repo.submit(message: 'meri baat', screen: '/jobs');

      verify(() => api.submitFeedback(
            authToken: 'tok',
            message: 'meri baat',
            category: null,
            screen: '/jobs',
          )).called(1);
      verify(() => api.submitFeedback(
            authToken: 'tok',
            message: 'meri baat',
            category: null,
          )).called(1);
    });

    test('a 400 with NO screen to drop is the server answering about the message',
        () async {
      // Not every 400 is the unknown key. With nothing to retry without, the
      // refusal is surfaced as-is rather than posted a second time.
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(ApiException(400, 'message is too long'));

      await expectLater(
        repo.submit(message: 'x'),
        throwsA(isA<InvalidRequestFailure>()),
      );
      // Posted ONCE. A blind retry would double-file the worker's report.
      verify(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).called(1);
    });

    test('a retry that also fails surfaces the failure, never a false success',
        () async {
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(ApiException(400, "Unrecognized key(s): 'screen'"));
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
          )).thenThrow(ApiException(403, 'consent required'));

      await expectLater(
        repo.submit(message: 'meri baat', screen: '/jobs'),
        throwsA(isA<ConsentRequiredFailure>()),
      );
    });

    test('a NON-400 refusal is never retried', () async {
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(ApiException(429, 'slow down'));

      await expectLater(
        repo.submit(message: 'meri baat', screen: '/jobs'),
        throwsA(isA<RateLimitedFailure>()),
      );
      verify(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).called(1);
    });
  });

  group('attachment_paths', () {
    test('uploaded paths reach the wire unchanged', () async {
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
            attachmentPaths: any(named: 'attachmentPaths'),
          )).thenAnswer((_) async {});

      await repo.submit(
        message: 'photo ke saath',
        screen: '/settings/notifications',
        attachmentPaths: const <String>[
          'feedback-attachments/w1/a.jpg',
          'feedback-attachments/w1/b.jpg',
        ],
      );

      verify(() => api.submitFeedback(
            authToken: 'tok',
            message: 'photo ke saath',
            category: null,
            screen: '/settings/notifications',
            attachmentPaths: const <String>[
              'feedback-attachments/w1/a.jpg',
              'feedback-attachments/w1/b.jpg',
            ],
          )).called(1);
    });

    test('an EMPTY list is sent as null — never `[]` on the wire', () async {
      // A no-image submission must stay byte-identical to a released build, so
      // the key is absent (null), not an empty array.
      await repo.submit(message: 'seedha', attachmentPaths: const <String>[]);
      verify(() => api.submitFeedback(
            authToken: 'tok',
            message: 'seedha',
            category: null,
            screen: null,
            attachmentPaths: null,
          )).called(1);
    });

    test('a 400 on the screen body retries WITHOUT screen but KEEPS the paths',
        () async {
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
            attachmentPaths: any(named: 'attachmentPaths'),
          )).thenThrow(ApiException(400, "Unrecognized key(s): 'screen'"));
      when(() => api.submitFeedback(
            authToken: any(named: 'authToken'),
            message: any(named: 'message'),
            category: any(named: 'category'),
            attachmentPaths: any(named: 'attachmentPaths'),
          )).thenAnswer((_) async {});

      await repo.submit(
        message: 'meri baat',
        screen: '/jobs',
        attachmentPaths: const <String>['feedback-attachments/w1/a.jpg'],
      );

      // The images already uploaded — only `screen` is the unknown key, so the
      // attachments ride the retry.
      verify(() => api.submitFeedback(
            authToken: 'tok',
            message: 'meri baat',
            category: null,
            attachmentPaths: const <String>['feedback-attachments/w1/a.jpg'],
          )).called(1);
    });
  });

  test('no session token is a 401-shaped failure, never an anonymous post',
      () async {
    final FeedbackRepositoryImpl anon =
        FeedbackRepositoryImpl(api, SessionRepository());
    await expectLater(
      anon.submit(message: 'x'),
      throwsA(isA<UnauthorizedFailure>()),
    );
    verifyNever(() => api.submitFeedback(
          authToken: any(named: 'authToken'),
          message: any(named: 'message'),
          category: any(named: 'category'),
          screen: any(named: 'screen'),
        ));
  });
}
