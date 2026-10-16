import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show QualificationOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/keyboard_collapsing_header.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_screen.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

class _MockRepo extends Mock implements TradeFormRepository {}

/// Counts its own mounts, so a test can prove the header was never rebuilt
/// from scratch (a remount is what makes a page flicker and a field lose focus).
class _MountCounter extends StatefulWidget {
  const _MountCounter({required this.onMount});

  final VoidCallback onMount;

  @override
  State<_MountCounter> createState() => _MountCounterState();
}

class _MountCounterState extends State<_MountCounter> {
  @override
  void initState() {
    super.initState();
    widget.onMount();
  }

  @override
  Widget build(BuildContext context) =>
      const SizedBox(height: 200, child: ColoredBox(color: Colors.red));
}

TradeForm _formWith(TradeFormStep step, String title) => TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(id: 's', title: title, screens: <TradeFormStep>[step]),
      ],
    );

const VoiceQuestion _q = VoiceQuestion(
  id: 'turning_machine',
  prompt: 'Aap kaunsi turning machine chalate hain?',
  kind: VoiceQuestionKind.open,
);

/// ── `issue1.jpeg`: the keyboard left almost none of the form visible ──────
void main() {
  group('KeyboardCollapsingHeader', () {
    Future<void> pumpHeader(
      WidgetTester tester, {
      required bool collapsed,
      required VoidCallback onMount,
      double statusBar = 24,
    }) =>
        tester.pumpWidget(
          MaterialApp(
            home: MediaQuery(
              data: MediaQueryData(padding: EdgeInsets.only(top: statusBar)),
              child: Scaffold(
                body: Column(
                  children: <Widget>[
                    KeyboardCollapsingHeader(
                      collapsed: collapsed,
                      child: _MountCounter(onMount: onMount),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );

    testWidgets('folds to the status-bar band, and back, WITHOUT remounting',
        (WidgetTester tester) async {
      int mounts = 0;
      void onMount() => mounts++;
      await pumpHeader(tester, collapsed: false, onMount: onMount);
      final Finder header = find.byType(KeyboardCollapsingHeader);
      expect(tester.getSize(header).height, 200);

      await pumpHeader(tester, collapsed: true, onMount: onMount);
      await tester.pump(const Duration(milliseconds: 110));
      final double midway = tester.getSize(header).height;
      expect(midway, lessThan(200), reason: 'it animates, it does not snap');
      expect(midway, greaterThan(24));

      await tester.pumpAndSettle();
      expect(tester.getSize(header).height, 24,
          reason: 'only the navy status-bar band is left');

      await pumpHeader(tester, collapsed: false, onMount: onMount);
      await tester.pumpAndSettle();
      expect(tester.getSize(header).height, 200);

      expect(mounts, 1,
          reason: 'the header is never rebuilt from scratch — no flicker');
    });
  });

  group('on the real form screen', () {
    late _MockRepo repo;

    setUpAll(() {
      registerFallbackValue(const TradeFormAnswer.declined());
    });

    setUp(() async {
      await locator.reset();
      repo = _MockRepo();
      when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
      when(() => repo.loadSavedEmployment())
          .thenAnswer((_) async => const TradeFormStoredEmployment());
      when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
      when(() => repo.loadQualificationOptions()).thenAnswer(
        (_) async => const QualificationOptionsDto(
          educationCredential: <String, String>{'iti': 'ITI'},
          educationCouncil: <String, String>{'ncvt': 'NCVT'},
        ),
      );
      locator.registerFactory<TradeFormCubit>(() => TradeFormCubit(repo));
    });

    tearDown(() => locator.reset());

    Future<void> pumpForm(WidgetTester tester, TradeForm form) async {
      when(() => repo.loadForm()).thenAnswer((_) async => form);
      tester.view.physicalSize = const Size(400, 860);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final GoRouter router = GoRouter(
        initialLocation: '/f',
        routes: <RouteBase>[
          GoRoute(path: '/f', builder: (_, __) => const TradeFormScreen()),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();
    }

    double headerHeight(WidgetTester tester) =>
        tester.getSize(find.byType(KeyboardCollapsingHeader)).height;

    Future<void> openKeyboard(WidgetTester tester) async {
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      await tester.pumpAndSettle();
    }

    Future<void> closeKeyboard(WidgetTester tester) async {
      tester.view.resetViewInsets();
      await tester.pumpAndSettle();
    }

    testWidgets('WORK HISTORY: the whole header folds while the keyboard is up',
        (WidgetTester tester) async {
      await pumpForm(tester, _formWith(const TradeFormEmploymentStep(), 'Work history'));
      final double open = headerHeight(tester);
      expect(open, greaterThan(100));

      await openKeyboard(tester);
      expect(headerHeight(tester), 0, reason: 'no status bar in a test view');

      await closeKeyboard(tester);
      expect(headerHeight(tester), open, reason: 'back exactly as it was');
      expect(tester.takeException(), isNull);
    });

    testWidgets('EDUCATION & CERTIFICATES: the same', (WidgetTester tester) async {
      await pumpForm(
        tester,
        _formWith(const TradeFormQualificationsStep(), 'Qualifications'),
      );
      final double open = headerHeight(tester);
      await openKeyboard(tester);
      expect(headerHeight(tester), 0);
      await closeKeyboard(tester);
      expect(headerHeight(tester), open);
    });

    testWidgets('a QUESTION page keeps its header — only the two pages fold',
        (WidgetTester tester) async {
      await pumpForm(
        tester,
        _formWith(const TradeFormQuestionStep(question: _q, searchable: false),
            'Machines'),
      );
      final double open = headerHeight(tester);
      await openKeyboard(tester);
      expect(headerHeight(tester), greaterThan(0));
      expect(headerHeight(tester), open);
    });
  });
}
