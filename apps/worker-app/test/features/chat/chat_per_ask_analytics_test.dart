import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

// #1316 — abandonment by ask index must be measurable on the CHAT interview (the
// flow workers actually reach), not only on the unreachable voice_form. Each
// ANSWERED ask must emit `profiling_answer_spoken` with its 1-based index, so a
// drop-off-by-ask-index curve is derivable for a completed AND an abandoned
// session — while carrying ONLY the index (no question, no answer text).
//
// The bloc emits via an injectable [ChatAnalyticsSink] whose production default
// is [BbAnalytics.instance]; here it is redirected into a recorder so the indices
// are observable without a live Firebase.
void main() {
  late MockChatRepository repo;
  late List<BbAnalyticsEvent> events;

  setUp(() {
    repo = MockChatRepository();
    events = <BbAnalyticsEvent>[];
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
  });

  /// The 1-based indices carried by every per-ask event so far, in emit order.
  List<int> spokenIndices() => events
      .where((BbAnalyticsEvent e) => e.name == 'profiling_answer_spoken')
      .map((BbAnalyticsEvent e) => e.parameters['question_index']! as int)
      .toList();

  ChatBloc buildBloc() => ChatBloc(repo, analyticsSink: events.add);

  test('each answered ask in the chat emits its 1-based index (#1316)',
      () async {
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(reply: 'ok'));

    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    bloc.add(const ChatMessageSent('welder hoon'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    bloc.add(const ChatMessageSent('das saal'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    bloc.add(const ChatMessageSent('Fanuc'));
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(spokenIndices(), <int>[1, 2, 3],
        reason: 'the Nth answered ask reports index N — a derivable curve');
  });

  test('the per-ask event carries ONLY the index — never the answer text',
      () async {
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(reply: 'ok'));

    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    const String answer = 'Rahul, 9876543210, Kanpur';
    bloc.add(const ChatMessageSent(answer));
    await Future<void>.delayed(const Duration(milliseconds: 40));

    final BbAnalyticsEvent spoken = events
        .singleWhere((BbAnalyticsEvent e) => e.name == 'profiling_answer_spoken');
    expect(spoken.parameters.keys, <String>['question_index'],
        reason: 'the sole parameter is the index — no free text field exists');
    expect(spoken.parameters['question_index'], 1);
    expect(spoken.parameters.values, isNot(contains(answer)),
        reason: 'the worker answer must never ride the event (invariant #2)');
  });

  test('a voice-merged answer emits its per-ask index too (#1316)', () async {
    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    bloc.add(const ChatVoiceMerged(
      transcript: 'CNC par chaar saal ka anubhav',
      reply: 'Badhiya! Kaunsa control chalate ho?',
    ));
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(spokenIndices(), <int>[1],
        reason: 'a voice answer is an answered ask — recorded on merge');
  });

  test('a mixed typed + voice interview keeps the indices contiguous (#1316)',
      () async {
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(reply: 'ok'));

    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    bloc.add(const ChatMessageSent('typed one'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    bloc.add(const ChatVoiceMerged(transcript: 'spoken two', reply: 'r'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    bloc.add(const ChatMessageSent('typed three'));
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(spokenIndices(), <int>[1, 2, 3]);
  });

  // The abandonment reading itself: a worker answers two asks, then the third
  // send FAILS and they walk away. The curve must show 1, 2 and stop — a failed
  // ask is not an answered ask, so it emits nothing.
  test('an abandoned session stops the curve at the last ANSWERED ask (#1316)',
      () async {
    int calls = 0;
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async {
      calls++;
      if (calls == 3) throw const NetworkFailure();
      return const ChatTurn(reply: 'ok');
    });

    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    bloc.add(const ChatMessageSent('one'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    bloc.add(const ChatMessageSent('two'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    bloc.add(const ChatMessageSent('three fails')); // never delivered
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(spokenIndices(), <int>[1, 2],
        reason: 'the failed third ask never records — drop-off reads at 2');
  });

  // A failed ask emits nothing; the SAME ask, once its retry succeeds, emits
  // exactly once and at its own index — no double-count, no phantom failed event.
  test('a failed-then-retried ask emits exactly once, at its index (#1316)',
      () async {
    int calls = 0;
    when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async {
      calls++;
      if (calls == 1) throw const NetworkFailure();
      return const ChatTurn(reply: 'ok');
    });

    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    bloc.add(const ChatMessageSent('cnc'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(spokenIndices(), isEmpty,
        reason: 'a failed send is not yet an answered ask');

    // Tap-to-retry the failed worker bubble (index 1; index 0 is the opener).
    bloc.add(const ChatRetryRequested(1));
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(spokenIndices(), <int>[1],
        reason: 'the successful retry records the ask once, at its index');
  });

  test('a completed session yields a full curve alongside the wrap-up (#1316)',
      () async {
    int calls = 0;
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async {
      calls++;
      // The engine calls the interview complete on the third turn.
      return ChatTurn(reply: 'ok', extractionReady: calls >= 3);
    });

    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    for (int i = 0; i < 3; i++) {
      bloc.add(ChatMessageSent('answer $i'));
      await Future<void>.delayed(const Duration(milliseconds: 40));
    }

    expect(spokenIndices(), <int>[1, 2, 3],
        reason: 'every answered ask contributes to the completed-session curve');
    expect(
      events.where((BbAnalyticsEvent e) => e.name == 'bb_chat_wrap_up').length,
      1,
      reason: 'the terminal wrap-up still fires exactly once',
    );
  });
}
