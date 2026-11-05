import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/features/find/presentation/widgets/find_view_switch.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// How the shell reaches Find's two views (owner rulings 2026-11-03): the nav
/// tab and Home's Browse open ALL CANDIDATES; a Jobs card's "Applicants"
/// button still reaches Find the way it always did, now landing on the
/// APPLICANTS view.
void main() {
  const AppSession session = AppSession(
    role: PayerRole.company,
    account: PayerAccount(
      name: 'Kalyani Industries',
      plan: 'Starter',
      initials: 'KI',
    ),
  );

  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  Future<void> pumpShell(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: BlocProvider<AppSessionCubit>.value(
          value: locator<AppSessionCubit>(),
          child: const AppShell(session: session),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> tapNav(WidgetTester tester, String label) async {
    await tester.tap(find.descendant(
      of: find.byType(BbBottomNav),
      matching: find.text(label),
    ));
    await tester.pumpAndSettle();
  }

  FindView selected(WidgetTester tester) =>
      tester.widget<FindViewSwitch>(find.byType(FindViewSwitch)).selected;

  testWidgets('the Find tab opens on All candidates', (WidgetTester tester) async {
    await pumpShell(tester);

    await tapNav(tester, 'Find');

    expect(selected(tester), FindView.allCandidates);
    // The All-candidates view is on stage (its filters; #2593 dropped the
    // "ALL CANDIDATES" eyebrow that repeated the switch).
    expect(find.byKey(const Key('candidate_filters_open')), findsOneWidget);
  });

  testWidgets('a Jobs card\'s "Applicants" lands on the Applicants view; the '
      'nav tab afterwards opens All candidates again',
      (WidgetTester tester) async {
    await pumpShell(tester);
    await tapNav(tester, 'Jobs');

    await tester.tap(find.text('Applicants').first);
    await tester.pumpAndSettle();

    expect(selected(tester), FindView.applicants);
    expect(find.text('CANDIDATES FOR CNC SETTER'), findsOneWidget);

    await tapNav(tester, 'Find');

    expect(selected(tester), FindView.allCandidates);
  });
}
