// The Resume tab's DATA rules (UI kit v3 §4) — the promises the design makes
// about the worker's own resume, driven through the real screen.
//
// The spec's artboard is a turner called Isabella Swan with '₹35,000', a
// '7 Verified' pill and a GD&T callout. Every one of those is a PLACEHOLDER.
// What this file pins is the opposite of the artboard: a block with no data
// behind it is NOT drawn, a count is a count and not a claim, and no raw
// attribute id, trade slug or scalar token ever reaches the glass.
//
// Card-slot mapping itself is unit-tested in resume_card_slots_test.dart; this
// file is about what the SCREEN does with it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_callout.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_card.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_pill.dart'
    show KitCountPill, KitPill;
import 'package:badabhai_worker_app/core/widgets/kit/kit_salary_box.dart';
import 'package:badabhai_worker_app/router.dart';

import 'resume_document_fixtures.dart';
import 'resume_tab_harness.dart';

/// Every string rendered anywhere on screen — the only honest way to assert
/// that a raw id is nowhere, rather than nowhere in the one place we looked.
List<String> _visibleText(WidgetTester tester) {
  final List<String> out = <String>[];
  for (final Element e in find.byType(Text).evaluate()) {
    final Text text = e.widget as Text;
    if (text.data != null) out.add(text.data!);
    final InlineSpan? span = text.textSpan;
    if (span != null) out.add(span.toPlainText());
  }
  return out;
}

void main() {
  final ResumeTabHarness harness = ResumeTabHarness();

  tearDown(ResumeTabHarness.reset);

  /// Pumps the tab and lets the handoff's two emits + the card's own
  /// self-load settle. Fixed pumps, never `pumpAndSettle`: the ready banner
  /// carries a one-shot stamp animation.
  Future<void> pumpTab(WidgetTester tester) async {
    // Deliberately roomy: this file judges WHAT is on screen, not how it
    // folds. Every size/scale case lives in resume_tab_responsive_test.dart.
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(harness.app());
    await tester.pump();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  group(
    'a full trade sheet — every block has data, so every block is drawn',
    () {
      setUp(() async {
        await harness.wire(
          document: kTurnerSheet,
          renderStatus: 'rendered',
          profileConfirmed: false,
          name: 'Suresh Yadav',
        );
      });

      testWidgets('the worker\'s own facts fill the profile card', (
        WidgetTester tester,
      ) async {
        await pumpTab(tester);

        expect(find.text('Your resume'), findsOneWidget);
        expect(find.text('Suresh Yadav'), findsOneWidget);
        // The server's composed masthead, verbatim — never re-split.
        expect(
          find.text('CNC Turner · 8 yrs · Fanuc · 2-axis'),
          findsOneWidget,
        );
        expect(
          find.text('Faridabad · Available now · expects ₹32,000'),
          findsOneWidget,
        );
        // The salary the server already formatted, in the money box.
        expect(find.byType(KitSalaryBox), findsOneWidget);
        expect(find.text('₹24,000 – ₹28,000 / month'), findsOneWidget);
      });

      testWidgets('the trade cards carry the SERVER\'s titles and values', (
        WidgetTester tester,
      ) async {
        await pumpTab(tester);

        expect(find.text('Machines, controllers & capability'), findsOneWidget);
        expect(find.text('OPERATED MACHINES'), findsOneWidget);
        expect(find.text('CNC lathe / turning centre'), findsOneWidget);
        expect(find.text('CONTROLLERS KNOWN'), findsOneWidget);
        expect(find.text('Fanuc Oi-TF'), findsOneWidget);
        // Materials get their own card, titled as the server named the row.
        expect(find.text('Materials'), findsOneWidget);
        expect(find.text('Brass'), findsOneWidget);
        // Operations, workholding, instruments, and a key this build does not
        // model ('Setting') — nothing is dropped.
        expect(find.text('WORKHOLDING KNOWLEDGE'), findsOneWidget);
        expect(find.text('3-jaw chuck'), findsOneWidget);
        expect(find.text('MEASURING INSTRUMENTS'), findsOneWidget);
        expect(find.text('SETTING'), findsOneWidget);
        expect(find.text('Tool offset setting'), findsOneWidget);
        // The drawing callout, with the server's own wording.
        expect(find.byType(KitCallout), findsOneWidget);
        expect(find.text('Reads 2D drawings and GD&T'), findsOneWidget);
        // Zones the spec omits still get a card.
        expect(find.text('Availability & terms'), findsOneWidget);
        expect(
          find.text('Qualification, documents & languages'),
          findsOneWidget,
        );
        // …and the work history.
        expect(find.text('Work History'), findsOneWidget);
        // Employer + role + location, composed in the server's own order with
        // the separators it already prefixed.
        expect(
          find.text('ABC Precision Ltd — CNC Turner · Gurugram, Haryana'),
          findsOneWidget,
        );
        expect(find.text('and 2 more'), findsOneWidget);
      });

      testWidgets('a count pill is DIGITS, never the spec\'s "7 Verified"', (
        WidgetTester tester,
      ) async {
        await pumpTab(tester);

        // 2 machines + 2 controllers = 4 on the capability card, and 4
        // materials on its own card — both real counts, both digits.
        expect(find.widgetWithText(KitCountPill, '4'), findsNWidgets(2));
        expect(find.widgetWithText(KitCountPill, '3'), findsOneWidget);
        expect(find.textContaining('Verified'), findsNothing);
        for (final String s in _visibleText(tester)) {
          expect(
            RegExp(r'^\d+\s+\w').hasMatch(s) && s.contains('Verified'),
            isFalse,
            reason: 'a count pill must not claim verification: "$s"',
          );
        }
      });

      testWidgets('NO raw id, slug or scalar token reaches the screen', (
        WidgetTester tester,
      ) async {
        await pumpTab(tester);

        final String all = _visibleText(tester).join(' | ');
        for (final String token in <String>[
          'cnc_turner',
          'turning_machine',
          'controller_brand',
          'material_worked',
          'drawing_reading',
          'setting_operation',
          'below_10',
          'trade_sheet',
        ]) {
          expect(all, isNot(contains(token)), reason: '"$token" is on screen');
        }
      });

      testWidgets('the DRAFT pill shows for an unconfirmed profile only', (
        WidgetTester tester,
      ) async {
        await pumpTab(tester);
        expect(find.text('WORKER PROFILE'), findsOneWidget);
        expect(
          find.widgetWithText(KitPill, 'DRAFT'),
          findsOneWidget,
          reason: 'this worker\'s profile is not confirmed',
        );
      });
    },
  );

  group('the hide rules — a block with no data is not drawn', () {
    testWidgets('no salary row → no money box; no drawing row → no callout; '
        'no materials → no materials card; no controllers → no '
        'CONTROLLERS KNOWN', (WidgetTester tester) async {
      await harness.wire(
        document: kSparseSheet,
        renderStatus: 'rendered',
        profileConfirmed: true,
      );
      await pumpTab(tester);

      // The one machine this worker DID declare is on screen…
      expect(find.text('Conventional lathe'), findsOneWidget);
      expect(find.text('OPERATED MACHINES'), findsOneWidget);
      // …and every block with nothing behind it is absent, not empty.
      expect(find.byType(KitSalaryBox), findsNothing);
      expect(find.byType(KitCallout), findsNothing);
      expect(find.text('CONTROLLERS KNOWN'), findsNothing);
      expect(find.text('Materials'), findsNothing);
      expect(find.text('WORKHOLDING KNOWLEDGE'), findsNothing);
      // An empty zone never becomes a content-less card.
      expect(find.text('Extras'), findsNothing);
    });

    testWidgets('an empty NAME hides the name line instead of printing a '
        'placeholder', (WidgetTester tester) async {
      await harness.wire(
        document: kSparseSheet,
        renderStatus: 'rendered',
        name: '',
        profileConfirmed: true,
      );
      await pumpTab(tester);

      // The card is still there, with its Edit affordance and the trade line.
      expect(find.bySemanticsLabel('Edit resume'), findsOneWidget);
      expect(find.text('CNC Turner · 2 yrs'), findsOneWidget);
      // Nothing invented in the name's place.
      expect(find.text('WORKER PROFILE'), findsOneWidget);
      expect(find.text('Suresh Yadav'), findsNothing);
    });

    testWidgets('showPhoto false paints the neutral placeholder, never a '
        'stranger\'s photo', (WidgetTester tester) async {
      await harness.wire(
        document: kSparseSheet,
        renderStatus: 'rendered',
        hasPhoto: true,
        showPhoto: false,
        photoUrl: 'https://example.test/photo.jpg',
        profileConfirmed: true,
      );
      await pumpTab(tester);

      expect(find.byIcon(Icons.person_rounded), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    });

    testWidgets('a name+photo load failure costs the worker nothing but the '
        'garnish', (WidgetTester tester) async {
      await harness.wire(
        document: kTurnerSheet,
        renderStatus: 'rendered',
        editLoadThrows: true,
        profileConfirmed: true,
      );
      await pumpTab(tester);

      // No name, no photo — and the whole resume underneath still renders.
      expect(find.text('Suresh Yadav'), findsNothing);
      expect(find.byIcon(Icons.person_rounded), findsOneWidget);
      expect(find.text('CNC lathe / turning centre'), findsOneWidget);
      expect(find.text('Work History'), findsOneWidget);
    });
  });

  group('the READY pill is the PDF\'s real state (ruling R6)', () {
    testWidgets('render_status "rendered" earns the pill', (
      WidgetTester tester,
    ) async {
      await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
      await pumpTab(tester);

      expect(find.text('Resume taiyaar'), findsOneWidget);
      expect(find.widgetWithText(KitPill, 'READY'), findsOneWidget);
    });

    testWidgets('pending, failed and ABSENT all show the banner WITHOUT the '
        'pill — the tab never claims a PDF that is not there', (
      WidgetTester tester,
    ) async {
      for (final String? status in <String?>['pending', 'failed', null]) {
        await harness.wire(renderStatus: status, profileConfirmed: true);
        await pumpTab(tester);

        expect(
          find.text('Resume taiyaar'),
          findsOneWidget,
          reason: 'the resume text is ready even when the PDF is not',
        );
        expect(
          find.widgetWithText(KitPill, 'READY'),
          findsNothing,
          reason: 'render_status ${status ?? 'absent'} is not "rendered"',
        );
        await ResumeTabHarness.reset();
      }
    });
  });

  group('the header and the correction affordance go where they say', () {
    setUp(() async {
      await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
    });

    testWidgets('the bell opens Alerts', (WidgetTester tester) async {
      await pumpTab(tester);

      await tester.tap(find.byIcon(Icons.notifications_outlined));
      await tester.pumpAndSettle();

      expect(harness.topPath, Routes.alerts);
      expect(find.text('alerts-stub'), findsOneWidget);
    });

    testWidgets('the yellow chat bubble is FEEDBACK, and carries the route '
        'the worker was on', (WidgetTester tester) async {
      await pumpTab(tester);

      await tester.tap(find.byIcon(Icons.chat_bubble_outline_rounded));
      await tester.pumpAndSettle();

      expect(harness.topPath, Routes.feedback);
      expect(harness.pushed.last.extra, Routes.resume);
    });

    testWidgets('"Report correction" goes to feedback with /resume attached', (
      WidgetTester tester,
    ) async {
      await pumpTab(tester);

      final Finder report = find.text('Report correction');
      await tester.scrollUntilVisible(report, 200);
      await tester.tap(report);
      await tester.pumpAndSettle();

      expect(harness.topPath, Routes.feedback);
      expect(harness.pushed.last.extra, Routes.resume);
    });

    testWidgets('the control note stays on the card stack, verbatim', (
      WidgetTester tester,
    ) async {
      await pumpTab(tester);
      final Finder note = find.text(
        'Naam / photo / phone aap control karte hain',
      );
      await tester.scrollUntilVisible(note, 200);
      expect(note, findsOneWidget);
    });
  });

  group('the edit round trip never burns a generate', () {
    testWidgets('a name change (pop true) refetches the card and the '
        'night-shift pref — and NEVER force-generates', (
      WidgetTester tester,
    ) async {
      await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
      harness.editPops = true;
      await pumpTab(tester);

      // The card's own name/photo load, plus the download button's prefetch.
      // Consume the mount-time reads (the card's own load + the download
      // button's name prefetch) so what follows counts only NEW ones.
      verify(() => harness.editRepo.load());

      await tester.tap(find.bySemanticsLabel('Edit resume'));
      await tester.pumpAndSettle();
      expect(harness.topPath, Routes.resumeEdit);

      await tester.tap(find.text('close-stub'));
      await tester.pumpAndSettle();
      expect(harness.topPath, Routes.resume);

      // The card was re-keyed (fresh load) and refreshNightShift ran — both
      // read the safe fields again.
      expect(
        verify(() => harness.editRepo.load()).callCount,
        greaterThan(0),
        reason:
            'the card must re-read the name/photo, and refreshNightShift '
            'must re-read the pref, after the editor closes',
      );
      // THE POINT: no forced regenerate. That would mint a new 'pending'
      // resume version, bin the rendered PDF and spend one of the worker's
      // five daily generates.
      verifyNever(() => harness.repo.generateResume(force: true));
    });

    testWidgets('a dismissed editor (pop null) is treated as "no name change" '
        'and still force-generates nothing', (WidgetTester tester) async {
      await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
      harness.editPops = null;
      await pumpTab(tester);

      await tester.tap(find.bySemanticsLabel('Edit resume'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('close-stub'));
      await tester.pumpAndSettle();

      expect(harness.topPath, Routes.resume);
      expect(find.text('Resume taiyaar'), findsOneWidget);
      verifyNever(() => harness.repo.generateResume(force: true));
    });
  });

  group('the non-ready states keep the same chrome', () {
    testWidgets('noProfile sends the worker to finish their profile', (
      WidgetTester tester,
    ) async {
      await harness.wire(
        resumeText: null,
        generateThrows: const ProfileIncompleteFailure(),
      );
      await pumpTab(tester);

      expect(find.text('Your resume'), findsOneWidget);
      expect(find.text('Abhi resume nahi ban sakta.'), findsOneWidget);

      await tester.tap(find.text('Profile poora karein'));
      await tester.pumpAndSettle();
      expect(harness.topPath, Routes.consent);
    });

    testWidgets('a failure offers Try again under the same header, and the '
        'retry is NOT a force', (WidgetTester tester) async {
      await harness.wire(
        resumeText: null,
        generateThrows: const ServerFailure(500),
      );
      await pumpTab(tester);

      expect(find.text('Your resume'), findsOneWidget);
      expect(find.text('Resume abhi ban nahi paya.'), findsOneWidget);
      // No banner over a resume that does not exist (#820's rule, kept).
      expect(find.text('Resume taiyaar'), findsNothing);

      await tester.tap(find.text('Try again'));
      await tester.pump();
      verifyNever(() => harness.repo.generateResume(force: true));
    });

    testWidgets('the loading state is the shared status surface, not a bare '
        'spinner', (WidgetTester tester) async {
      await harness.wire(resumeText: null, generateNeverResolves: true);
      await pumpTab(tester);

      expect(find.text('Your resume'), findsOneWidget);
      expect(find.byType(KitCard), findsNothing);
      expect(find.text('Resume taiyaar'), findsNothing);
    });
  });

  group('the legacy text path still reads as itself (#1343)', () {
    testWidgets('a worker with NO structured document gets the parsed '
        'sections, with the education token humanized', (
      WidgetTester tester,
    ) async {
      await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
      await pumpTab(tester);

      expect(find.text('General Info'), findsOneWidget);
      expect(find.text('Technical Skills'), findsOneWidget);
      expect(find.text('Education & Certifications'), findsOneWidget);
      // The salary is lifted into the money box and formatted like money.
      expect(find.text('₹24,000 / month'), findsOneWidget);
      // `below_10` is a raw scalar and must never be shown.
      final String all = _visibleText(tester).join(' | ');
      expect(all, isNot(contains('below_10')));
      expect(all, contains('10th se kam'));
    });
  });
}
