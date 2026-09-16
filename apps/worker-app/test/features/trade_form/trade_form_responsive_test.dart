// UI kit v3, decision D13 — the responsive contract for the trade form (the
// user-approved form-flow drawing kept by ruling R14: navy header + STEP line,
// the progress strip, the question headline in the body, traced option-card
// glyphs, the hint chip, the decline link and the docked SUNIE bar).
//
// What is pinned here:
//  1. the SIZE × TEXT-SCALE matrix on a question screen — nothing throws, and
//     the docked "Aage badhein" is still on screen (it is docked, so it must be
//     present at every size without scrolling);
//  2. a SHORT phone with the KEYBOARD UP at 2.0 on the one screen that types —
//     the open-answer question;
//  3. a TABLET — the option column stops at the kit's form width;
//  4. TAP TARGETS on a real handset;
//  5. D11 — option keys, question ids and the pack id never reach the glass.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show CityOptionDto, QualificationOptionsDto, WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/form_flow_parts.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/selection_cards.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_screen.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

import '../../support/kit_matrix.dart';

class _MockRepo extends Mock implements TradeFormRepository {}

const String _kNext = 'Aage badhein';

/// Slugs the worker must never see. Every one is a real wire value from the
/// fixtures below.
const List<String> _kWireSlugs = <String>[
  'turning_machine',
  'cnc_lathe',
  'vmc',
  'qp_cnc_turning',
  'cnc_turner',
];

const VoiceQuestion _optionsQuestion = VoiceQuestion(
  id: 'turning_machine',
  prompt: 'Aap kaunsi turning machine chalate hain?',
  kind: VoiceQuestionKind.multiSelect,
  whyText:
      'Isse company ko pata chalta hai aap kaunsi machine par kaam kar '
      'sakte hain.',
  options: <VoiceChoice>[
    VoiceChoice(key: 'cnc_lathe', label: 'CNC lathe'),
    VoiceChoice(key: 'vmc', label: 'VMC'),
  ],
);

const VoiceQuestion _openQuestion = VoiceQuestion(
  id: 'work_summary',
  prompt: 'Aap roz kya kaam karte hain?',
  kind: VoiceQuestionKind.open,
);

/// A question that is never reached — it exists so [first] is NOT the walk's
/// last step, which is what makes the docked bar read "Aage badhein" (the
/// everyday label) instead of the final "Submit karein".
const VoiceQuestion _tailQuestion = VoiceQuestion(
  id: 'shift_pref',
  prompt: 'Din ki shift theek hai?',
  kind: VoiceQuestionKind.boolean,
);

TradeForm _form(VoiceQuestion first) => TradeForm(
  kind: 'cnc_turner',
  packId: 'qp_cnc_turning',
  packVersion: 1,
  sections: <TradeFormSection>[
    TradeFormSection(
      id: 'capability',
      title: 'Machines, controllers & capability',
      screens: <TradeFormStep>[
        TradeFormQuestionStep(question: first, searchable: false),
        TradeFormQuestionStep(question: _tailQuestion, searchable: false),
      ],
    ),
  ],
);

const WorkPrefOptionsDto _prefOptions = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
  cities: <CityOptionDto>[
    CityOptionDto(value: 'Gurugram', aliases: <String>[], state: 'Haryana'),
  ],
  states: <String>['Haryana'],
);

const QualificationOptionsDto _qualOptions = QualificationOptionsDto(
  educationCredential: <String, String>{'iti': 'ITI'},
  educationCouncil: <String, String>{'ncvt': 'NCVT'},
);

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const TradeFormAnswer.declined());
    registerFallbackValue(const TradeFormPreferences());
    registerFallbackValue(<TradeFormEmploymentEntry>[]);
    registerFallbackValue(const TradeFormQualifications());
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(
      () => repo.loadPreferenceOptions(),
    ).thenAnswer((_) async => _prefOptions);
    when(
      () => repo.loadQualificationOptions(),
    ).thenAnswer((_) async => _qualOptions);
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    when(() => repo.saveQualifications(any())).thenAnswer((_) async {});
    locator.registerFactory<TradeFormCubit>(() => TradeFormCubit(repo));
  });

  tearDown(() async => locator.reset());

  /// Pumps the trade form at [size] and [scale], with an optional [keyboard].
  ///
  /// A real [GoRouter] because the screen's back arrow and its terminal hop
  /// both go through one; nothing here taps them, but the screen resolves the
  /// router from its context.
  Future<void> pumpForm(
    WidgetTester tester, {
    required Size size,
    required double scale,
    double keyboard = 0,
  }) async {
    setKitSurface(tester, size, keyboard: keyboard);
    final GoRouter router = GoRouter(
      initialLocation: '/trade-form',
      routes: <RouteBase>[
        GoRoute(
          path: '/trade-form',
          builder: (_, __) => const TradeFormScreen(),
        ),
        GoRoute(
          path: '/building',
          builder: (_, __) => const Scaffold(body: Text('BUILDING')),
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: router,
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  group('D13 matrix — a question screen on every phone shape and font size', () {
    for (final Size size in kKitMatrixSizes) {
      for (final double scale in kKitMatrixTextScales) {
        testWidgets(
          'the form holds at ${size.width.toInt()}x${size.height.toInt()} @ ${scale}x',
          (WidgetTester tester) async {
            when(
              () => repo.loadForm(),
            ).thenAnswer((_) async => _form(_optionsQuestion));

            await pumpForm(tester, size: size, scale: scale);

            expect(
              tester.takeException(),
              isNull,
              reason: 'the trade form threw at $size, text x$scale',
            );
            // The bar is DOCKED: at every size it is on screen without a
            // scroll, or the walk has no way forward.
            expect(find.text(_kNext), findsOneWidget);
            expect(find.text(_optionsQuestion.prompt), findsOneWidget);
          },
        );
      }
    }
  });

  testWidgets(
    'D13 small + keyboard — the open-answer question at 320x568 @2.0 with '
    'the keyboard up keeps its field and its docked bar',
    (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form(_openQuestion));

      await pumpForm(
        tester,
        size: const Size(320, 568),
        scale: 2.0,
        keyboard: 260,
      );

      expect(tester.takeException(), isNull);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text(_kNext), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'Lathe par kaam');
      await tester.pump();
      expect(tester.takeException(), isNull);
      // The prompt is above the fold at this size; it must still be reachable.
      await tester.ensureVisible(find.text(_openQuestion.prompt));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'the chrome collapses when the keyboard RISES and returns when it '
    'closes',
    (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form(_openQuestion));

      await pumpForm(tester, size: const Size(320, 568), scale: 2.0);
      expect(
        find.byType(FormProgressStrip),
        findsOneWidget,
        reason: 'the approved drawing, keyboard down',
      );

      // The worker taps the field: the keyboard arrives AFTER the build that
      // decided the chrome. A window reading would not have re-run that build,
      // so this is the case that pins the MediaQuery dependency.
      tester.view.viewInsets = const FakeViewPadding(bottom: 260);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);
      expect(
        find.byType(FormProgressStrip),
        findsNothing,
        reason: 'chrome sheds the strip while the keyboard crowds the screen',
      );
      expect(find.text(_kNext), findsOneWidget, reason: 'the action stays');

      tester.view.resetViewInsets();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(
        find.byType(FormProgressStrip),
        findsOneWidget,
        reason: 'the strip comes straight back when the keyboard closes',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('D13 tablet — the option column stops at the kit form width', (
    WidgetTester tester,
  ) async {
    when(
      () => repo.loadForm(),
    ).thenAnswer((_) async => _form(_optionsQuestion));

    await pumpForm(tester, size: const Size(768, 1024), scale: 1.0);

    expect(
      widthOf(tester, find.byType(MultiSelectQuestionCard).first),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
  });

  testWidgets('D6 tap targets — every control clears 48dp at 360x640', (
    WidgetTester tester,
  ) async {
    when(
      () => repo.loadForm(),
    ).thenAnswer((_) async => _form(_optionsQuestion));

    await pumpForm(tester, size: const Size(360, 640), scale: 1.0);

    // The back arrow, the option cards, the decline link, the SUNIE tile's
    // slot and the docked next button.
    await expectKitTapTargets(tester);
  });

  testWidgets('D8 focus — a form field\'s focus ring is navy, not yellow', (
    WidgetTester tester,
  ) async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form(_openQuestion));

    await pumpForm(tester, size: const Size(390, 844), scale: 1.0);

    final BorderSide focused =
        (tester
                    .widget<TextField>(find.byType(TextField))
                    .decoration!
                    .focusedBorder!
                as OutlineInputBorder)
            .borderSide;
    // Yellow is SELECTED (a ticked option card). A caret in a field is focus,
    // and focus is shiftBlue at 1.8 (spec §3.3, decision D8).
    expect(focused.color, OnboardingColors.shiftBlue);
    expect(focused.width, 1.8);
  });

  testWidgets(
    'D11 real data — no option key, question id or pack id is shown',
    (WidgetTester tester) async {
      when(
        () => repo.loadForm(),
      ).thenAnswer((_) async => _form(_optionsQuestion));

      await pumpForm(tester, size: const Size(390, 844), scale: 1.0);

      expect(find.text('CNC lathe'), findsOneWidget);
      expect(find.text('VMC'), findsOneWidget);
      for (final String slug in _kWireSlugs) {
        expect(
          find.textContaining(slug),
          findsNothing,
          reason: '$slug is a wire value, never worker-facing copy',
        );
      }
    },
  );
}
