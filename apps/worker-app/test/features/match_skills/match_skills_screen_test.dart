import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/core/widgets/bb_toggle.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/features/match_skills/domain/match_skill.dart';
import 'package:badabhai_worker_app/features/match_skills/domain/match_skills_repository.dart';
import 'package:badabhai_worker_app/features/match_skills/presentation/cubit/match_skills_cubit.dart';
import 'package:badabhai_worker_app/features/match_skills/presentation/match_skills_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/kit_matrix.dart';

/// In-memory stand-in for the three E4 routes, mirroring the REAL server:
/// OFF rows stay listed, PUT takes the resulting state, and clear-all turns
/// every row off (its `cleared` count is not surfaced — see #1850).
class _FakeRepo implements MatchSkillsRepository {
  _FakeRepo(List<MatchSkill> skills) : _rows = <MatchSkill>[...skills];

  List<MatchSkill> _rows;
  Failure? listFailure;
  Failure? writeFailure;
  final List<(String, bool)> puts = <(String, bool)>[];
  int clearCalls = 0;

  @override
  Future<List<MatchSkill>> list() async {
    if (listFailure != null) throw listFailure!;
    return List<MatchSkill>.of(_rows);
  }

  @override
  Future<bool> setWants(String skillId, {required bool wants}) async {
    puts.add((skillId, wants));
    if (writeFailure != null) throw writeFailure!;
    _rows = <MatchSkill>[
      for (final MatchSkill s in _rows)
        s.skillId == skillId ? s.withWants(wants) : s,
    ];
    return wants;
  }

  @override
  Future<void> clearAll() async {
    clearCalls++;
    _rows = <MatchSkill>[for (final MatchSkill s in _rows) s.withWants(false)];
  }
}

const List<MatchSkill> _two = <MatchSkill>[
  MatchSkill(skillId: 'mskill_cnc_turner', label: 'CNC Turner', wants: true),
  MatchSkill(skillId: 'mskill_vmc_operator', label: 'VMC Operator', wants: false),
];

const List<MatchSkill> _three = <MatchSkill>[
  MatchSkill(skillId: 'mskill_cnc_turner', label: 'CNC Turner', wants: true),
  MatchSkill(skillId: 'mskill_fitter', label: 'Fitter', wants: true),
  MatchSkill(skillId: 'mskill_vmc_operator', label: 'VMC Operator', wants: false),
];

void main() {
  late _FakeRepo repo;

  void register(List<MatchSkill> skills) {
    repo = _FakeRepo(skills);
    locator.registerFactory<MatchSkillsCubit>(() => MatchSkillsCubit(repo));
  }

  setUp(() async => locator.reset());

  tearDown(() async {
    bottomBarInset.value = 0;
    await locator.reset();
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(kitTestApp(const MatchSkillsScreen()));
    await tester.pump();
  }

  BbToggle toggleOf(WidgetTester tester, String skillId) => tester.widget<BbToggle>(
        find.descendant(
          of: find.byKey(ValueKey<String>('match-skill-$skillId')),
          matching: find.byType(BbToggle),
        ),
      );

  testWidgets('renders server labels as switches, OFF rows included, no raw id',
      (WidgetTester tester) async {
    register(_two);
    await pump(tester);

    expect(find.text(MatchSkillsCopy.title), findsOneWidget);
    expect(find.text(MatchSkillsCopy.hint), findsOneWidget);
    expect(find.text('CNC Turner'), findsOneWidget);
    expect(find.text('VMC Operator'), findsOneWidget);
    expect(find.textContaining('mskill_'), findsNothing);
    expect(toggleOf(tester, 'mskill_cnc_turner').value, isTrue);
    expect(toggleOf(tester, 'mskill_vmc_operator').value, isFalse);
  });

  testWidgets('a tap PUTs the resulting state and the row stays listed',
      (WidgetTester tester) async {
    register(_two);
    await pump(tester);

    await tester.tap(find.text('CNC Turner'));
    await tester.pump();
    await tester.pump();

    expect(repo.puts, <(String, bool)>[('mskill_cnc_turner', false)]);
    expect(find.text('CNC Turner'), findsOneWidget);
    expect(toggleOf(tester, 'mskill_cnc_turner').value, isFalse);
  });

  testWidgets('an OFF row can be turned back ON', (WidgetTester tester) async {
    register(_two);
    await pump(tester);

    await tester.tap(find.text('VMC Operator'));
    await tester.pump();
    await tester.pump();

    expect(repo.puts, <(String, bool)>[('mskill_vmc_operator', true)]);
    expect(toggleOf(tester, 'mskill_vmc_operator').value, isTrue);
  });

  testWidgets('a failed save says so and the switch keeps server truth',
      (WidgetTester tester) async {
    register(_two);
    await pump(tester);
    repo.writeFailure = const ServerFailure(404);

    await tester.tap(find.text('CNC Turner'));
    await tester.pump();
    await tester.pump();

    expect(find.text(MatchSkillsCopy.saveFailed), findsOneWidget);
    expect(toggleOf(tester, 'mskill_cnc_turner').value, isTrue);
  });

  testWidgets('a 400 reads as a stale list, a network failure names its cause',
      (WidgetTester tester) async {
    register(_two);
    await pump(tester);

    repo.writeFailure = const InvalidRequestFailure();
    await tester.tap(find.text('CNC Turner'));
    await tester.pump();
    await tester.pump();
    expect(find.text(MatchSkillsCopy.saveFailed), findsOneWidget);

    repo.writeFailure = const NetworkFailure();
    await tester.tap(find.text('CNC Turner'));
    await tester.pump();
    await tester.pump();
    expect(
      find.text('Server se connect nahi ho pa raha. Dobara try karein.'),
      findsOneWidget,
    );
    expect(toggleOf(tester, 'mskill_cnc_turner').value, isTrue);
  });

  testWidgets('clear-all needs a confirm, then every switch reads off',
      (WidgetTester tester) async {
    register(_two);
    await pump(tester);

    await tester.tap(find.widgetWithText(BbButton, MatchSkillsCopy.clearAll));
    await tester.pumpAndSettle();
    expect(find.text(MatchSkillsCopy.clearAllConfirm), findsOneWidget);
    expect(repo.clearCalls, 0);

    await tester.tap(find.text('Haan, band karein'));
    await tester.pumpAndSettle();

    expect(repo.clearCalls, 1);
    // One switch was on; the already-off row is not counted.
    expect(find.text('1 kaam band ho gaya.'), findsOneWidget);
    expect(toggleOf(tester, 'mskill_cnc_turner').value, isFalse);
    expect(toggleOf(tester, 'mskill_vmc_operator').value, isFalse);
  });

  testWidgets('clear-all counts only the switches it turned off',
      (WidgetTester tester) async {
    register(_three);
    await pump(tester);

    await tester.tap(find.widgetWithText(BbButton, MatchSkillsCopy.clearAll));
    await tester.pumpAndSettle();
    expect(find.text(MatchSkillsCopy.clearAllConfirmTitle), findsOneWidget);
    await tester.tap(find.text('Haan, band karein'));
    await tester.pumpAndSettle();

    expect(find.text('2 kaam band ho gaye.'), findsOneWidget);
  });

  testWidgets('cancelling the confirm clears nothing', (WidgetTester tester) async {
    register(_two);
    await pump(tester);

    await tester.tap(find.widgetWithText(BbButton, MatchSkillsCopy.clearAll));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rehne dein'));
    await tester.pumpAndSettle();

    expect(repo.clearCalls, 0);
    expect(toggleOf(tester, 'mskill_cnc_turner').value, isTrue);
  });

  testWidgets('clear-all is disabled once every row is already off',
      (WidgetTester tester) async {
    register(<MatchSkill>[_two[1]]);
    await pump(tester);

    final BbButton button =
        tester.widget(find.widgetWithText(BbButton, MatchSkillsCopy.clearAll));
    expect(button.onPressed, isNull);
  });

  testWidgets('an empty list shows the empty copy and no clear-all',
      (WidgetTester tester) async {
    register(const <MatchSkill>[]);
    await pump(tester);

    expect(find.text(MatchSkillsCopy.empty), findsOneWidget);
    expect(find.widgetWithText(BbButton, MatchSkillsCopy.clearAll), findsNothing);
  });

  testWidgets('a failed load names the real reason and retries',
      (WidgetTester tester) async {
    register(_two);
    repo.listFailure = const NetworkFailure();
    await pump(tester);

    expect(find.text(MatchSkillsCopy.loadFailed), findsOneWidget);
    expect(
      find.text('Server se connect nahi ho pa raha. Dobara try karein.'),
      findsOneWidget,
    );

    repo.listFailure = null;
    await tester.tap(find.text('Dobara try karein'));
    await tester.pump();
    await tester.pump();
    expect(find.text('CNC Turner'), findsOneWidget);
  });

  group('layout matrix', () {
    setUp(() => register(_two));
    kitMatrixTest(
      'match skills',
      () => const MatchSkillsScreen(),
      primary: () => find.widgetWithText(BbButton, MatchSkillsCopy.clearAll),
    );
  });
}
