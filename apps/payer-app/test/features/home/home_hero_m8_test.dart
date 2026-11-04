import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/credits_cubit.dart';
import 'package:payer_app/core/widgets/bb_card.dart';
import 'package:payer_app/core/widgets/bb_count_up.dart';
import 'package:payer_app/features/home/presentation/home_screen.dart';

/// #2596 (M8) — Home's hero: the one REAL figure on Home (the server-truth
/// credit balance) counts up to its value over 600ms. Unknown stays an honest
/// '—' (never a count from 0 towards nothing), a later change counts from the
/// figure on screen, and reduced motion shows the number at once.
class _BalanceApi extends MockPayerApiClient {
  int balance = 1250;
  bool fail = false;

  @override
  Future<int> fetchCreditBalance() async {
    if (fail) throw Exception('down');
    return balance;
  }
}

const AppSession _session = AppSession(
  role: PayerRole.company,
  account: PayerAccount(
    name: 'Kalyani Industries',
    plan: 'Starter',
    initials: 'KI',
  ),
);

void main() {
  late _BalanceApi api;

  setUp(() async {
    await GetIt.instance.reset();
    api = _BalanceApi();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  });

  Future<void> pumpHome(WidgetTester tester, {bool reduced = false}) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: app!,
        ),
        home: Scaffold(
          body: HomeScreen(
            session: _session,
            onPost: () {},
            onBrowse: () {},
            onOpenCredits: () {},
          ),
        ),
      ),
    );
  }

  /// The figure the hero shows right now.
  String figure(WidgetTester tester) => tester
      .widget<Text>(find.descendant(
        of: find.byKey(const Key('home_credit_balance_value')),
        matching: find.byType(Text),
      ))
      .data!;

  testWidgets('the real balance counts up from 0 over 600ms, then stops',
      (WidgetTester tester) async {
    await locator<CreditsCubit>().load();
    await pumpHome(tester);

    expect(figure(tester), '0');
    await tester.pump(const Duration(milliseconds: 300));
    final int mid = int.parse(figure(tester).replaceAll(',', ''));
    expect(mid, greaterThan(0));
    expect(mid, lessThan(1250));

    await tester.pump(const Duration(milliseconds: 300));
    expect(figure(tester), '1,250');
    // It stops on the real value — nothing loops, nothing overshoots.
    await tester.pump(const Duration(seconds: 1));
    expect(figure(tester), '1,250');
    expect(find.text('Credit balance'), findsOneWidget);
    expect(find.text('unlocks'), findsOneWidget);
    // The hero is the deep-blue balance block (the Credits screen's own).
    expect(
      tester
          .widget<BbCard>(find.ancestor(
            of: find.byKey(const Key('home_credit_balance_value')),
            matching: find.byType(BbCard),
          ))
          .ink,
      isTrue,
    );
    expect(tester.takeException(), isNull, reason: 'fits a 360×640 phone');
  });

  testWidgets('reduced motion: the real number at once',
      (WidgetTester tester) async {
    await locator<CreditsCubit>().load();
    await pumpHome(tester, reduced: true);
    await tester.pump();
    expect(figure(tester), '1,250');
  });

  testWidgets('unknown balance: an honest "—", no count from 0',
      (WidgetTester tester) async {
    await pumpHome(tester); // never loaded
    await tester.pump();
    expect(figure(tester), '—');
    expect(find.byType(BbCountUp), findsNothing);
  });

  testWidgets('a failed refresh: "—" + Retry, which re-reads server truth',
      (WidgetTester tester) async {
    await locator<CreditsCubit>().load();
    api.fail = true;
    await locator<CreditsCubit>().load();
    await pumpHome(tester);
    await tester.pumpAndSettle();

    expect(figure(tester), '—');
    expect(find.text('Retry'), findsOneWidget);

    api.fail = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(figure(tester), '1,250');
    expect(find.text('View ledger'), findsOneWidget);
  });

  testWidgets('a later change counts from the figure on screen, not from 0',
      (WidgetTester tester) async {
    await locator<CreditsCubit>().load();
    await pumpHome(tester);
    await tester.pumpAndSettle();
    expect(figure(tester), '1,250');

    api.balance = 1249; // one unlock spent
    await locator<CreditsCubit>().load();
    await tester.pump();
    expect(figure(tester), '1,250');
    await tester.pumpAndSettle();
    expect(figure(tester), '1,249');
  });
}
