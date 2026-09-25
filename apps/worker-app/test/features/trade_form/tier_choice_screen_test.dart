import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/profiling_tier.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_args.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/open_trade_form.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/tier_choice_screen.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/tier_option_card.dart';
import 'package:badabhai_worker_app/router.dart';

class _MockTradeFormRepository extends Mock implements TradeFormRepository {}

const String kFormMarker = 'TRADE-FORM';
const String kChatMarker = 'CHAT';

/// #1698 — the tier chooser: what it draws, what a tap does, and — the part
/// that matters most — that it only ever appears when the SERVER asks for it.
void main() {
  setUpAll(() => registerFallbackValue(ProfilingTier.easy));

  late _MockTradeFormRepository repo;

  TierEstimate est(ProfilingTier tier, int min, int max) =>
      TierEstimate(tier: tier, minMinutes: min, maxMinutes: max);

  TierState enabledState({
    bool needsChoice = true,
    ProfilingTier? current,
    List<ProfilingTier> upgradableTo = const <ProfilingTier>[],
  }) => TierState(
    enabled: true,
    kind: 'cnc_turner',
    needsChoice: needsChoice,
    currentTier: current,
    upgradableTo: upgradableTo,
    tiers: <TierEstimate>[
      est(ProfilingTier.easy, 2, 3),
      est(ProfilingTier.medium, 5, 7),
      est(ProfilingTier.hard, 10, 12),
    ],
  );

  setUp(() async {
    await locator.reset();
    repo = _MockTradeFormRepository();
      // #1710 — every load() now READS each marker page's stored record before
      // it draws. Nothing is stored in these tests, so the reads answer
      // "nothing saved", which is the state they were written against.
      when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
      when(() => repo.loadSavedEmployment())
          .thenAnswer((_) async => const TradeFormStoredEmployment());
      when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
    locator.registerFactory<TradeFormRepository>(() => repo);
  });

  tearDown(() async => locator.reset());

  Future<GoRouter> pump(
    WidgetTester tester,
    Widget home, {
    String initial = '/home',
  }) async {
    tester.view.physicalSize = const Size(420, 1200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final GoRouter router = GoRouter(
      initialLocation: initial,
      routes: <RouteBase>[
        GoRoute(path: '/home', builder: (_, __) => home),
        GoRoute(
          path: Routes.tierChoice,
          builder: (_, GoRouterState s) {
            final Object? extra = s.extra;
            if (extra is! TierChoiceArgs) return const Scaffold();
            return TierChoiceScreen(
              state: extra.state,
              entry: extra.entry,
              sectionKey: extra.sectionKey,
            );
          },
        ),
        GoRoute(
          path: Routes.tradeForm,
          builder: (_, GoRouterState s) => Scaffold(
            body: Text(
              '$kFormMarker '
              '${s.extra is TradeFormArgs ? (s.extra! as TradeFormArgs).upgradeView : false} '
              '${s.extra is TradeFormArgs ? (s.extra! as TradeFormArgs).sectionKey : s.extra}',
            ),
          ),
        ),
        GoRoute(
          path: Routes.chatProfiling,
          builder: (_, __) => const Scaffold(body: Text(kChatMarker)),
        ),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    return router;
  }

  group('the chooser only appears when the SERVER asks for it', () {
    Widget opener(TierEntry entry) => Builder(
      builder: (BuildContext context) => Scaffold(
        body: Center(
          child: TextButton(
            onPressed: () => openTradeFormWithTier(context, entry: entry),
            child: const Text('go'),
          ),
        ),
      ),
    );

    testWidgets('tiers OFF opens the form directly — today\'s behaviour',
        (WidgetTester tester) async {
      when(() => repo.loadTierState())
          .thenAnswer((_) async => TierState.disabled);
      await pump(tester, opener(TierEntry.pushed));

      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      expect(find.textContaining(kFormMarker), findsOneWidget);
      expect(find.text(kTierScreenTitle), findsNothing);
    });

    testWidgets('needs_choice FALSE opens the form directly, even with tiers '
        'enabled', (WidgetTester tester) async {
      when(() => repo.loadTierState()).thenAnswer(
        (_) async => enabledState(needsChoice: false, current: ProfilingTier.hard),
      );
      await pump(tester, opener(TierEntry.pushed));

      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      expect(find.textContaining(kFormMarker), findsOneWidget);
    });

    testWidgets('an enabled server with NO cards opens the form directly',
        (WidgetTester tester) async {
      when(() => repo.loadTierState()).thenAnswer(
        (_) async => const TierState(enabled: true, needsChoice: true),
      );
      await pump(tester, opener(TierEntry.pushed));

      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      expect(find.textContaining(kFormMarker), findsOneWidget);
      expect(find.text(kTierScreenTitle), findsNothing);
    });

    testWidgets('needs_choice TRUE shows the chooser', (
      WidgetTester tester,
    ) async {
      when(() => repo.loadTierState()).thenAnswer((_) async => enabledState());
      await pump(tester, opener(TierEntry.pushed));

      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      expect(find.text(kTierScreenTitle), findsOneWidget);
      expect(find.textContaining(kFormMarker), findsNothing);
    });

    testWidgets('a section key survives the direct path', (
      WidgetTester tester,
    ) async {
      when(() => repo.loadTierState())
          .thenAnswer((_) async => TierState.disabled);
      await pump(
        tester,
        Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => openTradeFormWithTier(
                  context,
                  entry: TierEntry.pushed,
                  sectionKey: 'section_technical_skills',
                ),
                child: const Text('go'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('section_technical_skills'),
        findsOneWidget,
        reason: 'losing it turns a one-section edit into the whole form',
      );
    });
  });

  group('the three cards', () {
    Future<void> show(
      WidgetTester tester, {
      TierEntry entry = TierEntry.pushed,
      TierState? state,
    }) async {
      await pump(
        tester,
        const Scaffold(),
        initial: Routes.tierChoice,
      );
      // The route above needs its extra, so drive it through the opener
      // instead: pump a screen that navigates on the first frame.
      await tester.pumpWidget(
        MaterialApp(
          home: TierChoiceScreen(state: state ?? enabledState(), entry: entry),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('draws Easy, Medium and Hard with the SERVER\'s minutes',
        (WidgetTester tester) async {
      await show(tester);

      expect(find.text(kTierEasyTitle), findsOneWidget);
      expect(find.text(kTierMediumTitle), findsOneWidget);
      expect(find.text(kTierHardTitle), findsOneWidget);
      expect(find.text('About 2–3 min'), findsOneWidget);
      expect(find.text('About 5–7 min'), findsOneWidget);
      expect(find.text('About 10–12 min'), findsOneWidget);
    });

    testWidgets('the minutes are NOT hard-coded — a different role gets '
        'different numbers', (WidgetTester tester) async {
      await show(
        tester,
        state: TierState(
          enabled: true,
          needsChoice: true,
          tiers: <TierEstimate>[est(ProfilingTier.easy, 4, 6)],
        ),
      );
      expect(find.text('About 4–6 min'), findsOneWidget);
      expect(find.text('About 2–3 min'), findsNothing);
    });

    testWidgets('only the HARD card carries the BadaBhai Recommended badge',
        (WidgetTester tester) async {
      await show(tester);
      expect(find.text(kBadaBhaiRecommendedLabel), findsOneWidget);
    });

    testWidgets('every card announces its title, badge and time to a screen '
        'reader', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await show(tester);

      expect(
        find.bySemanticsLabel(
          RegExp('$kTierHardTitle.*$kBadaBhaiRecommendedLabel.*About 10–12 min'),
        ),
        findsOneWidget,
      );
      expect(
        find.bySemanticsLabel(RegExp('$kTierEasyTitle.*About 2–3 min')),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('an UPGRADE offers only the tiers the server allows',
        (WidgetTester tester) async {
      await show(
        tester,
        entry: TierEntry.upgrade,
        state: enabledState(
          needsChoice: false,
          current: ProfilingTier.easy,
          upgradableTo: <ProfilingTier>[ProfilingTier.hard],
        ),
      );

      expect(find.text(kTierHardTitle), findsOneWidget);
      expect(find.text(kTierEasyTitle), findsNothing,
          reason: 'a downgrade is a 409 and must never be offered');
      expect(find.text(kTierMediumTitle), findsNothing);
      expect(find.text(kTierUpgradeTitle), findsOneWidget);
    });
  });

  group('a tap', () {
    testWidgets('records the choice and opens the FULL form on `selected`',
        (WidgetTester tester) async {
      when(() => repo.loadTierState()).thenAnswer((_) async => enabledState());
      when(() => repo.chooseTier(ProfilingTier.medium)).thenAnswer(
        (_) async => const TierChoice(
          tier: ProfilingTier.medium,
          change: TierChange.selected,
        ),
      );

      await pump(
        tester,
        Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    openTradeFormWithTier(context, entry: TierEntry.pushed),
                child: const Text('go'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      await tester.tap(find.text(kTierMediumTitle));
      await tester.pumpAndSettle();

      verify(() => repo.chooseTier(ProfilingTier.medium)).called(1);
      expect(find.textContaining('$kFormMarker false'), findsOneWidget,
          reason: 'a first selection opens the ordinary full form');
    });

    testWidgets('asks for the UPGRADE view only when the server upgraded',
        (WidgetTester tester) async {
      when(() => repo.loadTierState()).thenAnswer((_) async => enabledState());
      when(() => repo.chooseTier(ProfilingTier.hard)).thenAnswer(
        (_) async => const TierChoice(
          tier: ProfilingTier.hard,
          previousTier: ProfilingTier.easy,
          change: TierChange.upgraded,
        ),
      );

      await pump(
        tester,
        Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    openTradeFormWithTier(context, entry: TierEntry.pushed),
                child: const Text('go'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      await tester.tap(find.text(kTierHardTitle));
      await tester.pumpAndSettle();

      expect(find.textContaining('$kFormMarker true'), findsOneWidget);
    });

    testWidgets('a FAILED tap keeps the worker on the screen with every card '
        'tappable again — never a dead end', (WidgetTester tester) async {
      when(() => repo.loadTierState()).thenAnswer((_) async => enabledState());
      when(() => repo.chooseTier(any()))
          .thenThrow(const InvalidRequestFailure('Tier cannot be lowered'));

      await pump(
        tester,
        Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    openTradeFormWithTier(context, entry: TierEntry.pushed),
                child: const Text('go'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();

      await tester.tap(find.text(kTierEasyTitle));
      await tester.pumpAndSettle();

      expect(find.text(kTierScreenTitle), findsOneWidget);
      expect(find.textContaining(kTierChoiceFailed), findsOneWidget);
      expect(find.textContaining(kFormMarker), findsNothing);

      // And it is tappable again.
      when(() => repo.chooseTier(ProfilingTier.easy)).thenAnswer(
        (_) async => const TierChoice(
          tier: ProfilingTier.easy,
          change: TierChange.selected,
        ),
      );
      await tester.tap(find.text(kTierEasyTitle));
      await tester.pumpAndSettle();
      expect(find.textContaining(kFormMarker), findsOneWidget);
    });
  });

  group('Back', () {
    testWidgets('returns to the chat when the chooser was PUSHED', (
      WidgetTester tester,
    ) async {
      when(() => repo.loadTierState()).thenAnswer((_) async => enabledState());
      await pump(
        tester,
        Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    openTradeFormWithTier(context, entry: TierEntry.pushed),
                child: const Text(kChatMarker),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text(kChatMarker));
      await tester.pumpAndSettle();
      expect(find.text(kTierScreenTitle), findsOneWidget);

      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text(kChatMarker), findsOneWidget);
      expect(find.text(kTierScreenTitle), findsNothing);
    });
  });
}
