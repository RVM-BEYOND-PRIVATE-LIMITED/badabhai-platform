import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/profiling_tier.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_args.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/open_trade_form.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/tier_choice_screen.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_screen.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/tier_option_card.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/router.dart';

class _MockRepo extends Mock implements TradeFormRepository {}

/// The form's FIRST question, as the owner saw it.
const VoiceQuestion _tenure = VoiceQuestion(
  id: 'tenure_tier',
  prompt: 'Kitna tajurba hai?',
  kind: VoiceQuestionKind.singleSelect,
  options: <VoiceChoice>[
    VoiceChoice(key: 'fresher', label: 'Fresher'),
    VoiceChoice(key: 'senior', label: 'Senior'),
  ],
);

const TradeForm _form = TradeForm(
  kind: 'cnc_turner',
  packId: 'qp_cnc_turning',
  packVersion: 1,
  sections: <TradeFormSection>[
    TradeFormSection(
      id: 'experience',
      title: 'Experience',
      screens: <TradeFormStep>[
        TradeFormQuestionStep(question: _tenure, searchable: false),
      ],
    ),
  ],
);

const TierState _needsChoice = TierState(
  enabled: true,
  kind: 'cnc_turner',
  needsChoice: true,
  tiers: <TierEstimate>[
    TierEstimate(tier: ProfilingTier.easy, minMinutes: 2, maxMinutes: 3),
    TierEstimate(tier: ProfilingTier.medium, minMinutes: 5, maxMinutes: 7),
    TierEstimate(tier: ProfilingTier.hard, minMinutes: 10, maxMinutes: 12),
  ],
);

/// ── Reported by KP: Back on "Kitna tajurba hai" left the whole flow ───────
///
/// The tier screen opened the form with `go`, replacing the stack, so Back on
/// the form's FIRST question had nothing to return to. It now pushes the form,
/// and Back lands on Easy / Medium / Hard again.
void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(ProfilingTier.easy);
    registerFallbackValue(const TradeFormAnswer.declined());
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(() => repo.loadTierState()).thenAnswer((_) async => _needsChoice);
    when(() => repo.chooseTier(any())).thenAnswer(
      (Invocation i) async =>
          TierChoice(tier: i.positionalArguments.first as ProfilingTier),
    );
    when(
      () => repo.loadForm(upgradeView: any(named: 'upgradeView')),
    ).thenAnswer((_) async => _form);
    when(() => repo.loadForm()).thenAnswer((_) async => _form);
    when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
    when(
      () => repo.loadSavedEmployment(),
    ).thenAnswer((_) async => const TradeFormStoredEmployment());
    when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
    locator.registerFactory<TradeFormRepository>(() => repo);
    locator.registerFactory<TradeFormCubit>(() => TradeFormCubit(repo));
  });

  tearDown(() async => locator.reset());

  Future<void> pumpFromChat(WidgetTester tester) async {
    tester.view.physicalSize = const Size(420, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final GoRouter router = GoRouter(
      initialLocation: '/chat',
      routes: <RouteBase>[
        GoRoute(
          path: '/chat',
          builder: (BuildContext context, __) => Scaffold(
            body: Center(
              child: TextButton(
                // The chat's form-offer card does exactly this.
                onPressed: () =>
                    openTradeFormWithTier(context, entry: TierEntry.pushed),
                child: const Text('CHAT — open form'),
              ),
            ),
          ),
        ),
        GoRoute(
          path: Routes.tierChoice,
          builder: (_, GoRouterState s) {
            final TierChoiceArgs args = s.extra! as TierChoiceArgs;
            return TierChoiceScreen(state: args.state, entry: args.entry);
          },
        ),
        GoRoute(
          path: Routes.tradeForm,
          builder: (_, GoRouterState s) {
            final Object? extra = s.extra;
            return TradeFormScreen(
              fromStart: extra is TradeFormArgs && extra.fromStart,
            );
          },
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    await tester.tap(find.text('CHAT — open form'));
    await tester.pumpAndSettle();
  }

  Future<void> chooseMedium(WidgetTester tester) async {
    await tester.tap(find.byType(TierOptionCard).at(1));
    await tester.pumpAndSettle();
  }

  Future<void> formBack(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Wapas'));
    await tester.pumpAndSettle();
  }

  testWidgets('Back on "Kitna tajurba hai" returns to Easy / Medium / Hard', (
    WidgetTester tester,
  ) async {
    await pumpFromChat(tester);
    expect(find.text(kTierScreenTitle), findsOneWidget);

    await chooseMedium(tester);
    expect(
      find.text('Kitna tajurba hai?'),
      findsOneWidget,
      reason: 'precondition: on the form\'s first question',
    );

    await formBack(tester);

    expect(
      find.text(kTierScreenTitle),
      findsOneWidget,
      reason: 'KP: Back must land on the tier screen',
    );
    expect(find.text('Kitna tajurba hai?'), findsNothing);
  });

  testWidgets('the cards work again after coming back', (
    WidgetTester tester,
  ) async {
    await pumpFromChat(tester);
    await chooseMedium(tester);
    await formBack(tester);

    await chooseMedium(tester);
    expect(
      find.text('Kitna tajurba hai?'),
      findsOneWidget,
      reason: 'a returned-to screen with locked cards would be a dead end',
    );
    verify(() => repo.chooseTier(ProfilingTier.medium)).called(2);
  });

  testWidgets('Back on the tier screen still returns to the chat', (
    WidgetTester tester,
  ) async {
    await pumpFromChat(tester);
    await chooseMedium(tester);
    await formBack(tester);

    await tester.tap(find.byTooltip('Wapas'));
    await tester.pumpAndSettle();
    expect(find.text('CHAT — open form'), findsOneWidget);
  });
}
