import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/credits/presentation/cubit/credits_screen_cubit.dart';

/// #366 — the Credits screen reads two endpoints in one load (balance, then
/// ledger). Untested, the seam that rots is the failure path: a balance that
/// falls back to 0 reads as "you are out of credits" (blocking every unlock),
/// and a half-failed load that still emits `ready` renders a real balance next
/// to an empty ledger as if the payer had never spent anything.
class _ScriptedCreditsApi extends MockPayerApiClient {
  int balance = 200;
  List<LedgerEntry> ledger = const <LedgerEntry>[
    LedgerEntry(
      label: 'Unlock — CNC Setter',
      amount: '−1',
      direction: LedgerDirection.debit,
    ),
  ];

  Object? throwOnBalance;
  Object? throwOnLedger;

  final List<String> calls = <String>[];

  @override
  Future<int> fetchCreditBalance() async {
    calls.add('balance');
    if (throwOnBalance != null) throw throwOnBalance!;
    return balance;
  }

  @override
  Future<List<LedgerEntry>> fetchCreditLedger({int limit = 20}) async {
    calls.add('ledger');
    if (throwOnLedger != null) throw throwOnLedger!;
    return ledger;
  }
}

void main() {
  late _ScriptedCreditsApi api;
  late CreditsScreenCubit cubit;

  setUp(() {
    api = _ScriptedCreditsApi();
    cubit = CreditsScreenCubit(api);
  });

  tearDown(() => cubit.close());

  test('initial state: balance unknown (null), empty ledger', () {
    expect(cubit.state.status, CreditsScreenStatus.initial);
    expect(cubit.state.balance, isNull);
    expect(cubit.state.ledger, isEmpty);
  });

  test('load reads the real balance and the real ledger', () async {
    await cubit.load();

    expect(cubit.state.status, CreditsScreenStatus.ready);
    expect(cubit.state.balance, 200);
    expect(cubit.state.ledger.single.label, 'Unlock — CNC Setter');
    expect(api.calls, <String>['balance', 'ledger']);
  });

  test('a genuine server zero IS shown as 0 (distinct from unknown)', () async {
    api.balance = 0;

    await cubit.load();

    expect(cubit.state.status, CreditsScreenStatus.ready);
    expect(cubit.state.balance, 0);
    expect(cubit.state.balance, isNotNull,
        reason: 'a real 0 must still render as 0 — only a FAILED read is "—"');
  });

  test('a failed balance read leaves the balance unknown, never a fake 0',
      () async {
    api.throwOnBalance = const PayerApiException(503);

    await cubit.load();

    expect(cubit.state.status, CreditsScreenStatus.error);
    expect(cubit.state.balance, isNull);
    expect(cubit.state.balance, isNot(0),
        reason: 'a 0-mask reads as "out of credits" and blocks every unlock');
    expect(api.calls, <String>['balance'],
        reason: 'the ledger read is pointless once the balance read failed');
  });

  test('a failed LEDGER read never emits a half-true ready state', () async {
    api.throwOnLedger = const PayerApiException(500);

    // The balance succeeds here — the regression to catch is emitting `ready`
    // with a real balance and a silently empty ledger.
    final Future<void> transitions = expectLater(
      cubit.stream.map((CreditsScreenState s) => s.status),
      emitsInOrder(<CreditsScreenStatus>[
        CreditsScreenStatus.loading,
        CreditsScreenStatus.error,
      ]),
    );

    await cubit.load();
    await transitions;

    expect(cubit.state.status, CreditsScreenStatus.error);
    expect(cubit.state.ledger, isEmpty);
  });

  test('an error after a good load keeps the last-known balance + ledger',
      () async {
    await cubit.load();
    final int? known = cubit.state.balance;
    expect(known, 200);

    api.throwOnBalance = const PayerApiException(500);
    await cubit.load();

    expect(cubit.state.status, CreditsScreenStatus.error);
    expect(cubit.state.balance, known,
        reason: 'the last-known number stays, flagged by the error state');
    expect(cubit.state.ledger, isNotEmpty);
  });

  test('a later successful load clears the error state', () async {
    api.throwOnBalance = const PayerApiException(500);
    await cubit.load();
    expect(cubit.state.status, CreditsScreenStatus.error);

    api
      ..throwOnBalance = null
      ..balance = 199;
    await cubit.load();

    expect(cubit.state.status, CreditsScreenStatus.ready);
    expect(cubit.state.balance, 199);
  });
}
