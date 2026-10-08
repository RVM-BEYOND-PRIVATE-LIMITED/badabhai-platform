import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_companion_keys.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── #2145 — A JOB OPENED FROM THE PROFILING CHAT IS COUNTED ────────────────
///
/// ADR-0051 R8 lets the profiling chat offer jobs. The tap ROUTING was already
/// ungated — `_sendChoice` runs `companionActionFor` on every chip — so a
/// `companion_job:<uuid>` chip served there already opened the job detail. What
/// was missing is the event: it fired only in companion mode, so a job opened
/// from the profiling chat went unmeasured.
void main() {
  late MockChatRepository repo;
  late List<BbAnalyticsEvent> events;

  setUp(() {
    repo = MockChatRepository();
    events = <BbAnalyticsEvent>[];
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.loadHistory()).thenAnswer((_) async => const []);
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
  });

  ChatBloc buildBloc() => ChatBloc(repo, analyticsSink: events.add);

  List<String> names() =>
      events.map((BbAnalyticsEvent e) => e.name).toList(growable: false);

  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 30));

  test('a job opened OUTSIDE the companion still records the job-open',
      () async {
    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);
    expect(bloc.state.companion, isFalse, reason: 'the profiling chat');

    bloc.add(ChatCompanionChipTapped(
      companionChipKeyClass('$kCompanionJobKeyPrefix'
          '11111111-1111-4111-8111-111111111111'),
      openedJob: true,
    ));
    await settle();

    expect(names(), contains('companion_job_opened'));
  });

  test('but NOT the companion chip-class counter — that series is the '
      "companion's own menu", () async {
    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    bloc.add(ChatCompanionChipTapped(
      companionChipKeyClass('$kCompanionJobKeyPrefix'
          '11111111-1111-4111-8111-111111111111'),
      openedJob: true,
    ));
    await settle();

    expect(names(), isNot(contains('companion_chip_tapped')));
  });

  test('a NON-job chip outside the companion emits nothing at all', () async {
    // An interview chip or a résumé-menu key must not leak into either series.
    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);

    bloc.add(ChatCompanionChipTapped(
      companionChipKeyClass(kCompanionResumeKey),
      openedJob: false,
    ));
    await settle();

    expect(events, isEmpty);
  });

  test('inside the companion BOTH still fire, exactly as before', () async {
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        const ChatTurn(reply: 'Recap.', companion: true, digestKey: 'k1'),
      ),
    );
    final ChatBloc bloc = buildBloc();
    addTearDown(bloc.close);
    bloc.add(const ChatCompanionStarted());
    await settle();
    expect(bloc.state.companion, isTrue);

    events.clear();
    bloc.add(ChatCompanionChipTapped(
      companionChipKeyClass('$kCompanionJobKeyPrefix'
          '11111111-1111-4111-8111-111111111111'),
      openedJob: true,
    ));
    await settle();

    expect(names(), containsAll(<String>[
      'companion_chip_tapped',
      'companion_job_opened',
    ]));
  });
}
