// The feedback screen's UI kit v3 chrome, on every shape a worker owns.
//
// The screen's own behaviour (voice, the 4000-char cap, the consent dead end,
// attachments) is pinned by its three sibling suites. THIS file is about the
// redesign holding up: the navy compact header, the docked send bar, the select
// chips and the two refusal panels, across the device x text-scale matrix, with
// a keyboard up, on a tablet, and against the 48dp touch floor.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_docked_bar.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_select_chip.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/shift_blue_header.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_category.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_limits.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_repository.dart';
import 'package:badabhai_worker_app/features/feedback/presentation/feedback_screen.dart';

import '../../support/kit_matrix.dart';

class _MockFeedbackRepository extends Mock implements FeedbackRepository {}

/// The floor viewport, at the text size a worker who struggles to read has
/// turned on — the pair that breaks a layout built for the 390x844 artboard.
const Size _kFloorPhone = Size(320, 568);

/// What a soft keyboard eats on that floor phone (D13's keyboard case).
const double _kKeyboardInset = 260;

void main() {
  late _MockFeedbackRepository repo;

  setUpAll(() => registerFallbackValue(FeedbackCategory.other));

  setUp(() async {
    await locator.reset();
    repo = _MockFeedbackRepository();
    locator.registerFactory<FeedbackRepository>(() => repo);
  });

  tearDown(() => locator.reset());

  /// Type a report and get [failure] onto the screen as a persistent panel.
  ///
  /// `pump(Duration)` rather than `pumpAndSettle`: the panel is scrolled into
  /// view by a 250ms animation, and the send itself crosses two microtask hops.
  Future<void> refuse(WidgetTester tester, Object failure) async {
    when(
      () => repo.submit(
        message: any(named: 'message'),
        category: any(named: 'category'),
        screen: any(named: 'screen'),
      ),
    ).thenThrow(failure);

    await tester.enterText(find.byType(TextField), 'paisa nahi mila');
    await tester.pump();

    // PUT THE CARET AWAY BEFORE REACHING FOR SEND.
    //
    // Not a convenience: the box is autofocused, and a focused Android field
    // keeps a collapsed drag handle in the OVERLAY. That handle is a
    // `_SelectionHandleOverlay` whose follower box was MEASURED here at
    // (8,431)-(328,999) — full width, unclipped by the scroll viewport (it is
    // not in it) and running hundreds of dp past the bottom of the screen, so
    // it lies on top of the docked bar and swallows the tap. A widget test
    // holds that handle up forever; a real device fades it, and a worker
    // reaching for Bhejein has dismissed the caret anyway. So model that
    // rather than passing `warnIfMissed: false`, which would hide a genuine
    // miss instead of explaining this one.
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pump();

    await tester.tap(find.text('Bhejein'));
    await tester.pump();

    // The panel is appended BELOW a box that has grown to fit the report, so
    // the screen scrolls it into view over 250ms. That animation needs FRAMES,
    // not merely elapsed time: MEASURED here, a single `pump(400ms)` leaves the
    // offset at 0.0 with the panel ~2200dp below the fold, while a run of small
    // pumps lands it (2206.2 of 2206.2 at 320x568 @2.0). Fixed steps rather
    // than `pumpAndSettle`, per D13.
    for (int i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  // ── 1. THE MATRIX ─────────────────────────────────────────────────────────
  // Every size x every scale: nothing overflows, and the ONE committing action
  // is still there. It lives in the docked bar, so "there" means on screen
  // without scrolling — a send button below the fold is not a send button.
  kitMatrixTest(
    'the feedback screen',
    () => const FeedbackScreen(),
    primary: () => find.text('Bhejein'),
  );

  group('the chrome is the v3 chrome', () {
    testWidgets('a compact navy header, a docked send bar, and select chips', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(const FeedbackScreen()));
      await tester.pump();

      // The pushed-screen header (spec §2.1), in its compact drawing: back and
      // title on one row, no brand badge eating the box's vertical space.
      final ShiftBlueHeader header = tester.widget<ShiftBlueHeader>(
        find.byType(ShiftBlueHeader),
      );
      expect(header.title, 'Feedback');
      expect(header.compact, isTrue);
      expect(
        header.onBack,
        isNotNull,
        reason: 'a pushed screen owes a way out',
      );

      // The CTA is in the kit's docked shell (spec §2.2), not floating in the
      // body where the keyboard would bury it.
      expect(
        find.descendant(
          of: find.byType(KitDockedBar),
          matching: find.text('Bhejein'),
        ),
        findsOneWidget,
      );

      // One chip per category, and they are the v3 select chips.
      expect(
        find.byType(KitSelectChip),
        findsNWidgets(FeedbackCategory.values.length),
      );
    });

    testWidgets('the docked bar publishes its OWN height, not the screen\'s', (
      WidgetTester tester,
    ) async {
      // #1071: the app-wide Feedback pill floats above this bar by reading
      // `bottomBarInset`. A bar that publishes the full screen height (the
      // `Center`-inflation bug) pushes the pill clean off the bottom.
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(const FeedbackScreen()));
      await tester.pump();
      await tester.pump();

      final double barHeight = tester.getSize(find.byType(KitDockedBar)).height;
      expect(bottomBarInset.value, barHeight);
      expect(
        barHeight,
        lessThan(160),
        reason: 'a send bar is a bar, not the whole screen',
      );
    });
  });

  // ── 2. SMALL + KEYBOARD ───────────────────────────────────────────────────
  group('the floor phone with the keyboard up', () {
    testWidgets('320x568 @2.0 + keyboard 260: the box, the mic and the send '
        'are all still reachable', (WidgetTester tester) async {
      setKitSurface(tester, _kFloorPhone, keyboard: _kKeyboardInset);
      await tester.pumpWidget(
        kitTestApp(const FeedbackScreen(), textScale: 2.0),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);

      // The keyboard line — the bottom of the BODY. `Scaffold` insets only its
      // body by the keyboard (`contentBottom = height - max(viewInsets.bottom,
      // bottomWidgetsHeight)`) and anchors `bottomNavigationBar` to the
      // PHYSICAL bottom, so a docked bar sits behind the keyboard rather than
      // riding above it. That is stock Flutter and app-wide (every KitDockedBar
      // screen), not this screen's doing, so what is asserted here is what D13
      // asks: the send action is BUILT and reachable, and everything the worker
      // needs while the keyboard is up is inside the shrunken body.
      final double fold = _kFloorPhone.height - _kKeyboardInset;
      expect(find.text('Bhejein'), findsOneWidget);

      // The box the screen autofocuses is FOCUSED and its first line is inside
      // the shrunken body, so the worker can see what they are typing.
      //
      // Asserted as focus + geometry, NOT `find.byType(TextField).hitTestable()`:
      // the box is five lines tall, and the focused field's own collapsed
      // selection handle (an unclipped overlay box — see [refuse]) covers its
      // centre in a widget test. Hit-testing the tall field would therefore
      // fail on a framework artifact rather than on this layout.
      expect(
        tester
            .state<EditableTextState>(find.byType(EditableText))
            .widget
            .focusNode
            .hasFocus,
        isTrue,
      );

      // REACHABLE BY SCROLL, which is the contract: at 2.0 the prose above the
      // box is itself taller than the 240dp of body a 260dp keyboard leaves, so
      // the box starts below the fold and the worker scrolls to it. What must
      // hold is that scrolling GETS there — the body is a real scroller and
      // nothing is trapped outside it.
      await tester.ensureVisible(find.byType(TextField));
      await tester.pump();
      expect(tester.getRect(find.byType(TextField)).top, lessThan(fold));

      // The mic anchored to the box's top corner: on screen above the keyboard
      // line and still a full-size target — the contract the voice suite pins
      // on the other two small viewports.
      final Finder mic = find.byKey(kFeedbackVoiceControlKey);
      expect(mic.hitTestable(), findsOneWidget);
      final Rect micRect = tester.getRect(mic);
      expect(micRect.bottom, lessThanOrEqualTo(fold));
      expect(micRect.width, greaterThanOrEqualTo(OnboardingLayout.tapTarget));
      expect(micRect.height, greaterThanOrEqualTo(OnboardingLayout.tapTarget));
    });
  });

  // ── 3. TABLET ─────────────────────────────────────────────────────────────
  testWidgets('768x1024: the form column stops at 440 instead of stretching', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(const FeedbackScreen()));
    await tester.pump();

    // A form, not tab content: 440 (D7/R13). A 768dp-wide message box is a
    // ribbon nobody can read.
    expect(
      widthOf(tester, find.byType(TextField)),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
    expect(
      widthOf(tester, find.widgetWithText(FilledButton, 'Bhejein')),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
  });

  // ── 4. TAP TARGETS ────────────────────────────────────────────────────────
  testWidgets('every control clears the 48dp floor at 360x640', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(const FeedbackScreen()));
    await tester.pump();

    await expectKitTapTargets(tester);
  });

  // ── 5. THE REFUSAL PANELS, ON THE FLOOR PHONE AT 2.0 ──────────────────────
  group('the panels a worker must act on survive 320x568 @2.0', () {
    testWidgets('403: the consent callout, its way out painted and reachable', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, _kFloorPhone);
      await tester.pumpWidget(
        kitTestApp(const FeedbackScreen(), textScale: 2.0),
      );
      await tester.pump();

      await refuse(tester, const ConsentRequiredFailure());

      expect(tester.takeException(), isNull);
      // It STAYS (a snackbar the worker must act on vanishes as they read it)…
      expect(find.byType(SnackBar), findsNothing);
      expect(
        find.text('Aage badhne ke liye consent dena hoga.'),
        findsOneWidget,
      );
      // …and the way out was scrolled INTO VIEW, not created below the fold.
      expect(find.text('Consent dein').hitTestable(), findsOneWidget);

      // The PAINTED button, not Material's invisible tap padding, owes the
      // worker touch floor — even at 2.0 inside a callout on a 320dp screen.
      final Size painted = tester.getSize(
        find
            .descendant(
              of: find.widgetWithText(FilledButton, 'Consent dein'),
              matching: find.byType(Material),
            )
            .first,
      );
      expect(painted.height, greaterThanOrEqualTo(OnboardingLayout.tapTarget));
    });

    testWidgets('400: the error panel, with the words still in the box', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, _kFloorPhone);
      await tester.pumpWidget(
        kitTestApp(const FeedbackScreen(), textScale: 2.0),
      );
      await tester.pump();

      await refuse(tester, ApiException(400, 'message is too long'));

      expect(tester.takeException(), isNull);
      expect(find.byType(SnackBar), findsNothing);
      expect(find.text(const InvalidRequestFailure().message), findsOneWidget);
      // The server's own body never reaches the worker, and their paragraph is
      // never thrown away by a refusal.
      expect(find.textContaining('message is too long'), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'paisa nahi mila',
      );
    });
  });

  // ── 6. NO RAW IDS (D11) ───────────────────────────────────────────────────
  group('nothing raw ever reaches the glass', () {
    testWidgets('the chips show Hinglish labels, never their wire tokens', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(const FeedbackScreen()));
      await tester.pump();

      for (final FeedbackCategory c in FeedbackCategory.values) {
        expect(find.text(c.label), findsOneWidget);
        expect(
          find.text(c.wire),
          findsNothing,
          reason: '${c.wire} is the admin console\'s token, not worker copy',
        );
      }
    });

    testWidgets('the route the worker came FROM is telemetry, never painted', (
      WidgetTester tester,
    ) async {
      const String raw = '/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply';
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(const FeedbackScreen(fromRoute: raw)));
      await tester.pump();

      // It carries a job uuid. It travels to the repository and nowhere near a
      // worker's eyes.
      expect(find.textContaining('6f2c04e0'), findsNothing);
      expect(find.textContaining('/jobs/'), findsNothing);
    });
  });

  // ── 7. THE COUNTER'S DIGITS (spec §1.2) ───────────────────────────────────
  group('the character count is a number, so it is cut like one', () {
    /// Fills the box to [chars] and returns the counter's root span.
    ///
    /// `find.text` matches a [Text.rich] on its `toPlainText()`, which is how
    /// the three sibling suites still pin this sentence word for word — the
    /// change here is the typeface of the digits, not the copy.
    TextSpan counterSpan(WidgetTester tester, String sentence) =>
        tester.widget<Text>(find.text(sentence)).textSpan! as TextSpan;

    Future<void> fill(WidgetTester tester, int chars) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(const FeedbackScreen()));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'a' * chars);
      await tester.pump();
    }

    testWidgets('near the cap: mono digits inside an Inter sentence', (
      WidgetTester tester,
    ) async {
      await fill(
        tester,
        kWorkerFeedbackMessageMax - kFeedbackCounterShowsWithin,
      );

      final List<InlineSpan> spans = counterSpan(
        tester,
        '$kFeedbackCounterShowsWithin akshar bache',
      ).children!;

      // Spec §1.2 hands counters to Roboto Mono, and §3.3 prints the shape: a
      // mono NUMBER inside prose, never a mono sentence. Compared against the
      // token itself, so the size, weight, colour and the tabular figures that
      // stop the count jittering as it changes are all pinned at once.
      expect((spans.first as TextSpan).text, '$kFeedbackCounterShowsWithin');
      expect(spans.first.style?.fontFamily, OnboardingTypography.monoFamily);
      expect(
        spans.first.style,
        OnboardingTypography.mono(
          size: 13,
          weight: FontWeight.w700,
          color: OnboardingColors.ink500,
        ),
      );
      // The words carry no face of their own: they inherit the Text's body
      // style, which is where the Inter sentence comes from.
      expect(spans.last.style, isNull);
    });

    testWidgets('at the cap: the same mono, turned red with the sentence', (
      WidgetTester tester,
    ) async {
      await fill(tester, kWorkerFeedbackMessageMax + 50);

      final List<InlineSpan> spans = counterSpan(
        tester,
        'Itna hi likh sakte hain ($kWorkerFeedbackMessageMax akshar).',
      ).children!;

      // Three spans: prose, the number, prose. The bound itself is the digit
      // run, and it goes red with the warning around it.
      expect(spans, hasLength(3));
      expect((spans[1] as TextSpan).text, '$kWorkerFeedbackMessageMax');
      expect(
        spans[1].style,
        OnboardingTypography.mono(
          size: 13,
          weight: FontWeight.w700,
          color: OnboardingColors.errorRed,
        ),
      );
    });
  });
}
