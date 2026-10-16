// The Résumé tab's "Resume upload karein" entry — the CEO's "upload at any
// point", driven through the real screen.
//
// Two promises. It is THERE in every state the tab draws something for: a
// résumé whose PDF is ready, still rendering, failed or unknown, a DRAFT
// profile, and no résumé at all. And it opens the upload screen as an ENTRY
// (`ResumeUploadDirectIntent`), never with the chat prompt's marker — that one
// raises an import signal which would answer some later chat prompt for the
// worker.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show
        GenericResumeDocument,
        PendingUpdate,
        ResumeDocumentHeaderDto,
        ResumeHistory,
        ResumeHistoryItem,
        ResumeSource,
        ResumeTrigger;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_action_row.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_document_view.dart'
    show ChatResumeView, ResumeDocumentView;
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_history_section.dart'
    show ResumeUpdateCard;
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_profile_card.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_sections.dart'
    show ResumeSectionsView;
import 'package:badabhai_worker_app/features/resume_import/domain/resume_upload_intent.dart';
import 'package:badabhai_worker_app/router.dart';

import 'resume_document_fixtures.dart';
import 'resume_tab_harness.dart';

void main() {
  final ResumeTabHarness harness = ResumeTabHarness();

  tearDown(ResumeTabHarness.reset);

  /// The data-rules suite's pump: fixed pumps, never `pumpAndSettle` before
  /// the first look — the READY banner carries a one-shot stamp animation.
  Future<void> pumpTab(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(harness.app());
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> tapEntry(WidgetTester tester) async {
    final Finder entry = find.byKey(kResumeTabUploadEntryKey);
    await tester.ensureVisible(entry);
    await tester.pump();
    await tester.tap(entry);
    await tester.pumpAndSettle();
  }

  /// Every state the tab draws something for, wired the way the app reaches
  /// it. Loading spinners are not here: they are a beat, not a state the
  /// worker can act from.
  final Map<String, Future<void> Function()> states =
      <String, Future<void> Function()>{
    'the PDF is ready': () =>
        harness.wire(renderStatus: 'rendered', profileConfirmed: true),
    'the PDF is still rendering': () =>
        harness.wire(renderStatus: 'pending', profileConfirmed: true),
    'the PDF failed to render': () =>
        harness.wire(renderStatus: 'failed', profileConfirmed: true),
    'the PDF state is unknown': () =>
        harness.wire(renderStatus: null, profileConfirmed: true),
    'the profile is a DRAFT': () =>
        harness.wire(renderStatus: 'rendered', profileConfirmed: false),
    'there is no résumé yet (profile unfinished)': () => harness.wire(
          resumeText: null,
          generateThrows: const ProfileIncompleteFailure(),
        ),
    'there is no résumé (the load failed)': () => harness.wire(
          resumeText: null,
          generateThrows: const ServerFailure(500),
        ),
  };

  states.forEach((String name, Future<void> Function() wire) {
    testWidgets('$name: the entry is there and opens the upload screen as an '
        'ENTRY', (WidgetTester tester) async {
      await wire();
      await pumpTab(tester);

      expect(find.byKey(kResumeTabUploadEntryKey), findsOneWidget);

      await tapEntry(tester);

      expect(harness.topPath, Routes.resumeUpload);
      expect(find.text('upload-stub'), findsOneWidget);
      expect(harness.pushed.last.path, Routes.resumeUpload);
      // The marker is the whole contract: the entry's, never the chat
      // prompt's (which raises a signal no prompt is waiting for).
      expect(harness.pushed.last.extra, isA<ResumeUploadDirectIntent>());
      expect(harness.pushed.last.extra, isNot(isA<ResumeUploadAutoIntent>()));
    });
  });

  /// The SAME promise across the résumé ROADS the ready tab renders — the
  /// form road's trade sheet, the chat road's own view, the legacy text, and a
  /// worker with older résumés. Each row first proves its body really drew
  /// (so it cannot quietly fall back to the legacy text), then that the entry
  /// sits ABOVE that body, where a worker finds it without scrolling past
  /// their whole résumé.
  ResumeHistoryItem historyItem(String id, int day, {bool current = false}) =>
      ResumeHistoryItem(
        resumeId: id,
        profileId: 'p1',
        source: ResumeSource.chat,
        trigger: ResumeTrigger.profileConfirmed,
        generatedAt: DateTime.utc(2026, 9, day),
        renderStatus: 'rendered',
        renderedAt: DateTime.utc(2026, 9, day),
        isCurrent: current,
      );

  final List<({String name, Future<void> Function() wire, Finder body})>
      roads = <({String name, Future<void> Function() wire, Finder body})>[
    (
      name: 'a form-road trade sheet',
      wire: () => harness.wire(
            document: kTurnerSheet,
            renderStatus: 'rendered',
            profileConfirmed: true,
          ),
      body: find.byType(ResumeDocumentView),
    ),
    (
      name: 'a chat-road résumé',
      wire: () => harness.wire(
            document: const GenericResumeDocument(
              header: ResumeDocumentHeaderDto(),
              source: 'chat',
            ),
            renderStatus: 'rendered',
            profileConfirmed: true,
          ),
      body: find.byType(ChatResumeView),
    ),
    (
      name: 'the legacy text body',
      wire: () =>
          harness.wire(renderStatus: 'rendered', profileConfirmed: true),
      body: find.byType(ResumeSectionsView),
    ),
    (
      name: 'a worker with older résumés',
      wire: () => harness.wire(
            renderStatus: 'rendered',
            profileConfirmed: true,
            history: ResumeHistory(
              items: <ResumeHistoryItem>[
                historyItem('r2', 20, current: true),
                historyItem('r1', 12),
              ],
            ),
          ),
      body: find.byType(ResumeSectionsView),
    ),
  ];

  for (final ({String name, Future<void> Function() wire, Finder body}) road
      in roads) {
    testWidgets('${road.name}: the entry sits above the résumé body and opens '
        'the upload screen as an ENTRY', (WidgetTester tester) async {
      await road.wire();
      await pumpTab(tester);

      expect(road.body, findsOneWidget,
          reason: 'precondition: this road\'s own body is what drew');
      final Finder entry = find.byKey(kResumeTabUploadEntryKey);
      expect(entry, findsOneWidget);
      expect(
        tester.getBottomLeft(entry).dy,
        lessThanOrEqualTo(tester.getTopLeft(road.body).dy),
        reason: 'buried under the résumé, a worker on a phone never sees it',
      );

      await tapEntry(tester);
      expect(harness.topPath, Routes.resumeUpload);
      expect(harness.pushed.last.extra, isA<ResumeUploadDirectIntent>());
    });
  }

  testWidgets('a PUSH over the tab — back returns to the résumé', (
    WidgetTester tester,
  ) async {
    await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
    await pumpTab(tester);

    await tapEntry(tester);
    expect(harness.topPath, Routes.resumeUpload);

    harness.router.pop();
    await tester.pumpAndSettle();
    expect(harness.topPath, Routes.resume);
    expect(find.text('Resume taiyaar'), findsOneWidget);
  });

  testWidgets('its own element: the card\'s share/download row stays exactly '
      'those two actions', (WidgetTester tester) async {
    await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
    await pumpTab(tester);

    // ResumeActionRow is EXACTLY share + download (R3): two tappable controls,
    // counted — of ANY kind, so a third action cannot hide as an icon button.
    final Finder cardRow = find.descendant(
      of: find.byType(ResumeProfileCard),
      matching: find.byType(ResumeActionRow),
    );
    expect(cardRow, findsOneWidget);
    expect(
      find.descendant(
        of: cardRow,
        matching: find.byWidgetPredicate(
          (Widget w) => w is ButtonStyleButton || w is IconButton,
        ),
      ),
      findsNWidgets(2),
    );
    expect(
      find.descendant(of: cardRow, matching: find.byType(BbButton)),
      findsNWidgets(2),
    );

    expect(
      find.descendant(
        of: find.byType(ResumeActionRow),
        matching: find.byKey(kResumeTabUploadEntryKey),
      ),
      findsNothing,
    );
    expect(
      find.descendant(
        of: find.byType(ResumeProfileCard),
        matching: find.byKey(kResumeTabUploadEntryKey),
      ),
      findsNothing,
    );
    // Under the card, above the résumé body: found without scrolling.
    expect(
      tester.getTopLeft(find.byKey(kResumeTabUploadEntryKey)).dy,
      greaterThan(tester.getBottomLeft(find.byType(ResumeProfileCard)).dy),
    );
    expect(
      tester.getBottomLeft(find.byKey(kResumeTabUploadEntryKey)).dy,
      lessThanOrEqualTo(
        tester.getTopLeft(find.byType(ResumeSectionsView)).dy,
      ),
    );
  });

  // #1688's rule: an update the worker accepted in chat is the FIRST answer
  // under the profile card ("did my Haan reach the resume?"). The entry goes
  // below it, never between them.
  testWidgets('an update in flight keeps its card first under the profile '
      'card — the entry sits below it', (WidgetTester tester) async {
    await harness.wire(
      renderStatus: 'rendered',
      profileConfirmed: true,
      history: const ResumeHistory(
        pendingUpdate: PendingUpdate(status: 'in_progress'),
      ),
    );
    await pumpTab(tester);

    final Finder update = find.byType(ResumeUpdateCard);
    expect(update, findsOneWidget, reason: 'precondition: the update card');
    expect(
      tester.getTopLeft(update).dy,
      greaterThan(tester.getBottomLeft(find.byType(ResumeProfileCard)).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(kResumeTabUploadEntryKey)).dy,
      greaterThan(tester.getBottomLeft(update).dy),
    );
  });

  testWidgets('a quiet outline button — the tab carries no yellow CTA', (
    WidgetTester tester,
  ) async {
    await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
    await pumpTab(tester);

    final BbButton button = tester.widget<BbButton>(
      find.ancestor(
        of: find.byKey(kResumeTabUploadEntryKey),
        matching: find.byType(BbButton),
      ),
    );
    expect(button.variant, BbButtonVariant.outline);
    expect(button.label, 'Resume upload karein');
  });

  testWidgets('with no résumé, it sits UNDER the state\'s own button, never in '
      'place of it', (WidgetTester tester) async {
    await harness.wire(
      resumeText: null,
      generateThrows: const ProfileIncompleteFailure(),
    );
    await pumpTab(tester);

    expect(find.text('Profile poora karein'), findsOneWidget);
    expect(
      tester.getTopLeft(find.byKey(kResumeTabUploadEntryKey)).dy,
      greaterThan(tester.getTopLeft(find.text('Profile poora karein')).dy),
    );
  });
}
