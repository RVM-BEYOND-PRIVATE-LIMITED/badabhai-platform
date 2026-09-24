// D13 — the interview-kit list and detail across every shape a worker owns, at
// system font scales 1.0 / 1.5 / 2.0, plus the redesigned list chrome (the
// interview_kit.png header with back tooltip 'Wapas', search, Audio, Bolein), a
// 600dp content cap on a tablet, and a 48dp floor on every tappable thing.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_card.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit_repository.dart';
import 'package:badabhai_worker_app/features/kit/presentation/cubit/kit_detail_cubit.dart';
import 'package:badabhai_worker_app/features/kit/presentation/cubit/kit_list_cubit.dart';
import 'package:badabhai_worker_app/features/kit/presentation/kit_detail_screen.dart';
import 'package:badabhai_worker_app/features/kit/presentation/kit_screen.dart';
import 'package:badabhai_worker_app/features/kit/presentation/widgets/interview_kit_widgets.dart';

import '../../support/kit_matrix.dart';

class _MockInterviewKitRepository extends Mock
    implements InterviewKitRepository {}

enum _Load { ready, empty, failed, hang }

const List<KitListItem> _items = <KitListItem>[
  KitListItem(
    tradeKey: 'cnc_operator',
    title: 'CNC Operator',
    subtitle: 'Common sawaal · checklist · documents',
  ),
  KitListItem(
    tradeKey: 'vmc_operator',
    title: 'VMC Operator',
    subtitle: 'Common sawaal · checklist · documents',
  ),
  KitListItem(
    tradeKey: 'fitter',
    title: 'Fitter',
    subtitle: 'Common sawaal · checklist · documents',
  ),
];

const InterviewKit _kit = InterviewKit(
  tradeKey: 'cnc_operator',
  title: 'CNC Operator',
  overview: 'Machine, drawing aur safety ki samajh check hoti hai.',
  commonQuestions: <String>[
    'Kaun si machine chalayi hai?',
    'Tool offset kaise set karte hain?',
  ],
  practicalQuestions: <String>['Saved program se job kaise start karte hain?'],
  safetyQuestions: <String>['Kaun sa PPE pehnte hain?'],
  drawingMeasurementQuestions: <String>['Tolerance kaise padhte hain?'],
  skillChecklist: <String>['Fanuc control', 'Micrometer'],
  reviseBefore: <String>['Basic G/M codes'],
  documentsToCarry: <String>['Aadhaar card (original + photocopy)'],
  commonMistakes: <String>['First piece inspection skip karna'],
  hinglishNote: 'Aaram se, saaf jawaab dein. Jo aata hai wahi bolein.',
);

void main() {
  late _MockInterviewKitRepository repo;
  _Load mode = _Load.ready;

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    repo = _MockInterviewKitRepository();
    when(() => repo.listKits()).thenAnswer((_) async {
      switch (mode) {
        case _Load.failed:
          throw const NetworkFailure();
        case _Load.hang:
          await Completer<void>().future;
          throw StateError('unreachable');
        case _Load.empty:
          return const <KitListItem>[];
        case _Load.ready:
          return _items;
      }
    });
    when(() => repo.kit(any())).thenAnswer((_) async {
      switch (mode) {
        case _Load.failed:
          throw const NetworkFailure();
        case _Load.hang:
          await Completer<void>().future;
          throw StateError('unreachable');
        case _Load.empty:
        case _Load.ready:
          return _kit;
      }
    });
    locator.registerFactory<KitListCubit>(() => KitListCubit(repo));
    locator.registerFactory<KitDetailCubit>(() => KitDetailCubit(repo));
  });

  tearDown(() async {
    mode = _Load.ready;
    await locator.reset();
  });

  Widget list({_Load load = _Load.ready}) {
    mode = load;
    return const KitScreen();
  }

  Widget detail({_Load load = _Load.ready}) {
    mode = load;
    return const KitDetailScreen(tradeKey: 'cnc_operator');
  }

  Future<void> pumpAt(
    WidgetTester tester,
    Widget child, {
    required Size size,
    double scale = 1.0,
  }) async {
    setKitSurface(tester, size);
    await tester.pumpWidget(kitTestApp(child, textScale: scale));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  kitMatrixTest(
    'the kit list survives every shape',
    () => list(),
    primary: () => find.text('CNC Operator'),
  );

  kitMatrixTest(
    'an empty kit list stays honest on every shape',
    () => list(load: _Load.empty),
    primary: () => find.text(
      'Abhi koi interview kit available nahi. Thodi der baad dekhein.',
    ),
  );

  kitMatrixTest(
    'a failed kit list survives every shape',
    () => list(load: _Load.failed),
    primary: () => find.text('Try again'),
  );

  kitMatrixTest(
    'the loading kit list survives every shape',
    () => list(load: _Load.hang),
    primary: () => find.byType(CircularProgressIndicator),
  );

  kitMatrixTest(
    'the kit detail survives every shape',
    () => detail(),
    primary: () => find.text('Aam sawaal'),
  );

  testWidgets('the list header keeps its back affordance in every state', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, list(load: _Load.failed), size: const Size(320, 568));

    // The chrome is built once, above the state switch — a failed load must not
    // strand the worker without a way back.
    expect(find.byTooltip('Wapas'), findsOneWidget);
    expect(find.text('Interview Kit'), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets(
    'the detail header names the real trade and offers the download',
    (WidgetTester tester) async {
      await pumpAt(tester, detail(), size: const Size(390, 844));

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.byIcon(Icons.download), findsOneWidget);
      expect(find.byTooltip('Wapas'), findsOneWidget);
      // Question numbers are real, sequential and mono — no fabricated count.
      expect(find.text('1.'), findsWidgets);
      expect(find.text('2.'), findsWidgets);
    },
  );

  testWidgets('a failed detail load offers no download button', (
    WidgetTester tester,
  ) async {
    await pumpAt(
      tester,
      detail(load: _Load.failed),
      size: const Size(390, 844),
    );

    expect(find.text('Kit load nahi hui.'), findsOneWidget);
    expect(find.byIcon(Icons.download), findsNothing);
    expect(find.byTooltip('Wapas'), findsOneWidget);
  });

  testWidgets('tablet: both kit screens cap their content column at 600', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, list(), size: const Size(768, 1024));
    expect(
      widthOf(tester, find.byType(InterviewKitCard).first),
      lessThanOrEqualTo(600),
    );

    await pumpAt(tester, detail(), size: const Size(768, 1024));
    expect(widthOf(tester, find.byType(KitCard).first), lessThanOrEqualTo(600));
  });

  testWidgets('every tappable thing on both kit screens clears 48dp', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, list(), size: const Size(360, 640));
    await expectKitTapTargets(tester);

    await pumpAt(tester, detail(), size: const Size(360, 640));
    await expectKitTapTargets(tester);
  });

  testWidgets('the ready list draws the mock chrome: section header and tip', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, list(), size: const Size(390, 844));

    expect(find.text('AVAILABLE TRADE KITS'), findsOneWidget);
    expect(find.text('Tap to open syllabus'), findsOneWidget);
    expect(find.byType(InterviewKitTipCard), findsOneWidget);
    expect(find.text(InterviewKitTipCard.title), findsOneWidget);
  });

  testWidgets('typing filters the loaded kits to a real title match', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, list(), size: const Size(390, 844));

    await tester.enterText(find.byKey(const Key('kitSearchField')), 'vmc');
    await tester.pump();

    expect(find.text('VMC Operator'), findsOneWidget);
    expect(find.text('CNC Operator'), findsNothing);
    expect(find.text('Fitter'), findsNothing);
  });

  testWidgets('a search that matches nothing says so, and can be cleared', (
    WidgetTester tester,
  ) async {
    await pumpAt(tester, list(), size: const Size(390, 844));

    await tester.enterText(
      find.byKey(const Key('kitSearchField')),
      'welder',
    );
    await tester.pump();

    expect(find.text(InterviewKitListView.emptySearch), findsOneWidget);
    // The catalogue is NOT empty — never the "no kits exist" line for a miss.
    expect(find.text(InterviewKitListView.emptyCatalogue), findsNothing);

    await tester.tap(find.text('Search saaf karein'));
    await tester.pump();

    expect(find.text('CNC Operator'), findsOneWidget);
    expect(find.text('VMC Operator'), findsOneWidget);
  });
}
