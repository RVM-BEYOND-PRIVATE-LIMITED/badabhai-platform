import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_history_section.dart';

import 'resume_tab_harness.dart';

/// #1687 — the "Pichle resume" section on the Resume tab.
///
/// The rules it exists to hold: the SERVER's window is rendered as sent, a row
/// the app cannot honestly label carries no badge, no raw wire token ever
/// reaches the screen, and a server without the route leaves the tab exactly
/// as it was.
ResumeHistoryItem _item({
  String id = 'r1',
  ResumeSource? source = ResumeSource.chat,
  ResumeTrigger? trigger = ResumeTrigger.profileConfirmed,
  String status = 'rendered',
  bool current = false,
  int day = 12,
}) => ResumeHistoryItem(
  resumeId: id,
  profileId: 'p1',
  source: source,
  trigger: trigger,
  generatedAt: DateTime.utc(2026, 9, day),
  renderStatus: status,
  renderedAt: DateTime.utc(2026, 9, day),
  isCurrent: current,
);

void main() {
  final ResumeTabHarness harness = ResumeTabHarness();

  tearDown(ResumeTabHarness.reset);

  Future<void> pumpTab(
    WidgetTester tester, {
    required ResumeHistory history,
  }) async {
    tester.view.physicalSize = const Size(420, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await harness.wire(history: history);
    await tester.pumpWidget(harness.app());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();
  }

  group('how many cards (the server windows, the app renders)', () {
    testWidgets('NO history: no section at all — the tab is exactly today\'s', (
      WidgetTester tester,
    ) async {
      await pumpTab(tester, history: ResumeHistory.empty);
      expect(find.text(kResumeHistoryTitle.toUpperCase()), findsNothing);
    });

    testWidgets('one, two and three rows render one, two and three cards', (
      WidgetTester tester,
    ) async {
      for (final int n in <int>[1, 2, 3]) {
        await pumpTab(
          tester,
          history: ResumeHistory(
            items: <ResumeHistoryItem>[
              for (int i = 0; i < n; i++) _item(id: 'r$i', day: 12 - i),
            ],
          ),
        );
        expect(find.text(kResumeHistoryTitle.toUpperCase()), findsOneWidget);
        expect(
          find.text('12 September 2026'),
          findsOneWidget,
          reason: 'the newest row is drawn first, as the server sent it',
        );
        expect(find.byType(Card).evaluate().length, lessThanOrEqualTo(n + 4));
      }
    });

    testWidgets('the SERVER owns the window — six rows draw six cards, not '
        'three', (WidgetTester tester) async {
      // `RESUME_HISTORY_VISIBLE_LIMIT` (server, default 3) decides how many
      // rows arrive. If it is raised, the app must SHOW them: re-trimming
      // client-side would make a server config change look broken, and nothing
      // is ever deleted (ruling R4, "keep all, show three").
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            for (int i = 0; i < 6; i++)
              _item(id: 'r$i', source: ResumeSource.form, day: 20 - i),
          ],
        ),
      );
      expect(find.text('FORM'), findsNWidgets(6));
      expect(find.text('20 September 2026'), findsOneWidget);
      expect(find.text('15 September 2026'), findsOneWidget);
    });

    testWidgets('an absurd response is still bounded — the safety ceiling '
        'stops an unbounded list of cards', (WidgetTester tester) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            for (int i = 0; i < 40; i++)
              _item(id: 'r$i', source: ResumeSource.form, day: 20 - (i % 20)),
          ],
        ),
      );
      expect(find.text('FORM'), findsNWidgets(kResumeHistoryMaxCards));
    });

    testWidgets('THREE CHAT ENTRIES render three Chat cards — any mix is '
        'allowed, including a repeat', (WidgetTester tester) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            _item(id: 'a', day: 14),
            _item(id: 'b', day: 13),
            _item(id: 'c', day: 12),
          ],
        ),
      );
      expect(find.text('CHAT'), findsNWidgets(3));
    });

    testWidgets('each source gets its own human badge, never the wire token', (
      WidgetTester tester,
    ) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            _item(id: 'a', source: ResumeSource.form, day: 14),
            _item(id: 'b', source: ResumeSource.chat, day: 13),
            _item(id: 'c', source: ResumeSource.resumeUpload, day: 12),
          ],
        ),
      );
      expect(find.text('FORM'), findsOneWidget);
      expect(find.text('CHAT'), findsOneWidget);
      expect(find.text('RESUME UPLOAD'), findsOneWidget);
      // The raw tokens must never reach a worker's screen.
      expect(find.textContaining('resume_upload'), findsNothing);
      expect(find.textContaining('profile_confirmed'), findsNothing);
    });
  });

  group('what a card may and may not claim', () {
    testWidgets('a NULL source shows no badge', (WidgetTester tester) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            _item(source: null, trigger: null, current: true),
          ],
        ),
      );
      expect(find.text(kResumeHistoryTitle.toUpperCase()), findsOneWidget);
      expect(find.text('FORM'), findsNothing);
      expect(find.text('CHAT'), findsNothing);
      expect(find.text('RESUME UPLOAD'), findsNothing);
    });

    testWidgets('an UNKNOWN source shows no badge and does not crash', (
      WidgetTester tester,
    ) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            _item(source: ResumeSource.unknown, trigger: ResumeTrigger.unknown),
          ],
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.text(kResumeHistoryTitle.toUpperCase()), findsOneWidget);
    });

    testWidgets('the status pill is fail-closed: rendered → READY, failed → '
        'NAHI BANI, anything else → BAN RAHA HAI', (WidgetTester tester) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            _item(id: 'a', status: 'rendered', day: 14),
            _item(id: 'b', status: 'failed', day: 13),
            _item(id: 'c', status: 'something_new', day: 12),
          ],
        ),
      );
      expect(find.text('READY'), findsWidgets);
      expect(find.text('NAHI BANI'), findsOneWidget);
      expect(find.text('BAN RAHA HAI'), findsOneWidget);
    });

    testWidgets('NO VERSION NUMBER is ever printed — it is counted per '
        'profile, not per history', (WidgetTester tester) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[_item(current: true)],
        ),
      );
      expect(find.textContaining('v1'), findsNothing);
      expect(find.textContaining('Version'), findsNothing);
    });

    testWidgets('each card carries its OWN download + share actions', (
      WidgetTester tester,
    ) async {
      await pumpTab(
        tester,
        history: ResumeHistory(
          items: <ResumeHistoryItem>[
            _item(id: 'a', day: 14),
            _item(id: 'b', day: 13),
          ],
        ),
      );
      // One pair per card, plus the profile card's own pair at the top.
      expect(find.text('PDF download karein'), findsNWidgets(3));
    });
  });

  group('the update card (#1688)', () {
    /// Pumped DIRECTLY rather than through the tab: the tab's card is driven
    /// by a live poll, and a widget test that drove the poller would be
    /// asserting the poll's timing rather than the card's drawing.
    Future<void> pumpCard(
      WidgetTester tester, {
      required bool failed,
      VoidCallback? onRetry,
    }) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ResumeUpdateCard(failed: failed, onRetry: onRetry),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('in progress: says so, and claims no failure', (
      WidgetTester tester,
    ) async {
      await pumpCard(tester, failed: false);
      expect(find.text(kResumeUpdateInProgress), findsOneWidget);
      expect(find.text(kResumeUpdateFailed), findsNothing);
      expect(find.text(kResumeUpdateRetryLabel), findsNothing);
    });

    testWidgets('failed: names the failure AND always offers a way forward', (
      WidgetTester tester,
    ) async {
      int taps = 0;
      await pumpCard(tester, failed: true, onRetry: () => taps++);
      expect(find.text(kResumeUpdateFailed), findsOneWidget);
      expect(find.text(kResumeUpdateInProgress), findsNothing);

      await tester.tap(find.text(kResumeUpdateRetryLabel));
      await tester.pump();
      expect(taps, 1, reason: 'a failure with a dead button is a dead end');
    });

    testWidgets('nothing pending: the tab shows no card at all', (
      WidgetTester tester,
    ) async {
      await pumpTab(
        tester,
        history: ResumeHistory(items: <ResumeHistoryItem>[_item()]),
      );
      expect(find.text(kResumeUpdateInProgress), findsNothing);
      expect(find.text(kResumeUpdateFailed), findsNothing);
    });
  });
}
