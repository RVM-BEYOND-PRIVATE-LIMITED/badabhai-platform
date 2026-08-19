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
