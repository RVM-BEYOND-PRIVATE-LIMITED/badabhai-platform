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

  /// Buy control: the balance the buy returns, or an error to throw.
  int buyBalance = 250;
  Object? throwOnBuy;

  final List<String> calls = <String>[];

  /// Every idempotency key `buyPack` forwards, in call order (for key-reuse
  /// assertions). Null when the caller passed none.
  final List<String?> buyKeys = <String?>[];

  @override
  Future<int> buyCreditPack(String code, {String? idempotencyKey}) async {
    calls.add('buy:$code');
    buyKeys.add(idempotencyKey);
    if (throwOnBuy != null) throw throwOnBuy!;
    return buyBalance;
  }

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
    // The four reads now fire concurrently (one round trip, not four), so the
    // balance read is attempted; its failure is what drives the error state above.
    expect(api.calls, contains('balance'));
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

  test('load also fetches the buyable packs (server-priced)', () async {
    await cubit.load();
    // The MockPayerApiClient base returns canned packs; a real screen shows them.
    expect(cubit.state.packs, isNotEmpty);
  });

  test('buyPack applies the new balance, re-reads the ledger, flags purchased',
      () async {
    await cubit.load();
    api
      ..buyBalance = 400
      ..ledger = const <LedgerEntry>[
        LedgerEntry(
          label: 'Pack purchase',
          amount: '+200',
          direction: LedgerDirection.credit,
        ),
      ];

    await cubit.buyPack('growth');

    expect(cubit.state.balance, 400);
    expect(cubit.state.purchasing, isNull);
    expect(cubit.state.purchased, isTrue);
    expect(cubit.state.purchaseFailed, isFalse);
    expect(cubit.state.ledger.first.label, 'Pack purchase',
        reason: 'the purchase row must appear — the ledger is re-read');
    expect(api.calls.contains('buy:growth'), isTrue);
  });

  test('a failed buy flags purchaseFailed and never touches the balance',
      () async {
    await cubit.load();
    final int? known = cubit.state.balance;
    api.throwOnBuy = const PayerApiException(503);

    await cubit.buyPack('growth');

    expect(cubit.state.purchaseFailed, isTrue);
    expect(cubit.state.purchasing, isNull);
    expect(cubit.state.balance, known,
        reason: 'a failed purchase must not change the shown balance');
  });

  // --- #1046 — client idempotency: one tap is one credit pack --------------

  test('buyPack forwards a non-empty idempotency key to buyCreditPack',
      () async {
    await cubit.load();

    await cubit.buyPack('growth');

    expect(api.buyKeys.single, isNotNull);
    expect(api.buyKeys.single, isNotEmpty);
    // PII-free by construction — the pack code + a numeric tail, no worker/payer
    // identifier.
    expect(api.buyKeys.single, contains('growth'));
  });

  test('a retry of the SAME pack after a failure REUSES the same key; a '
      'different pack mints a fresh one', () async {
    await cubit.load(); // balance 200
    api.throwOnBuy = const PayerApiException(503); // every buy fails

    await cubit.buyPack('growth'); // key #1, fails → pending kept
    await cubit.buyPack('growth'); // retry → REUSES key #1
    await cubit.buyPack('scale'); //  different pack → key #2

    expect(api.buyKeys, hasLength(3));
    expect(api.buyKeys[0], isNotNull);
    expect(api.buyKeys[1], api.buyKeys[0],
        reason: 'a re-tap of the same failed pack must replay, not double-grant');
    expect(api.buyKeys[2], isNot(api.buyKeys[0]),
        reason: 'a different pack is a different intent → a different key');
  });

  test('a failed buy RE-READS the balance; if it went up the grant landed → '
      'reported as SUCCEEDED (no double grant)', () async {
    await cubit.load(); // balance 200
    api
      ..throwOnBuy = const PayerApiException(408) // the write "times out"
      ..balance = 250 // …but the server had already committed the grant
      ..ledger = const <LedgerEntry>[
        LedgerEntry(
          label: 'Pack purchase',
          amount: '+50',
          direction: LedgerDirection.credit,
        ),
      ];

    await cubit.buyPack('starter');

    expect(cubit.state.purchased, isTrue,
        reason: 'a committed-then-errored buy is a success, not a retry');
    expect(cubit.state.purchaseFailed, isFalse);
    expect(cubit.state.balance, 250);
    expect(cubit.state.ledger.first.label, 'Pack purchase');
    expect(api.calls.where((String c) => c == 'buy:starter'), hasLength(1),
        reason: 'the grant is never re-issued — buyCreditPack ran exactly once');
  });

  test('a failed buy with an UNCHANGED balance keeps the key for a safe retry, '
      'then success clears it so the next intent mints a FRESH key', () async {
    await cubit.load(); // balance 200
    api.throwOnBuy = const PayerApiException(409); // in-flight → not yet up

    await cubit.buyPack('growth'); // fails, balance still 200 → pending kept
    final String? failedKey = api.buyKeys.single;
    expect(cubit.state.purchaseFailed, isTrue);

    // The retry reuses the key and this time the server answers.
    api.throwOnBuy = null;
    await cubit.buyPack('growth');
    expect(api.buyKeys[1], failedKey,
        reason: 'the safe retry replays the same key');
    expect(cubit.state.purchased, isTrue);

    // A brand-new purchase after a clean success mints a fresh key.
    await cubit.buyPack('growth');
    expect(api.buyKeys[2], isNot(failedKey),
        reason: 'success clears the pending key → a new intent, a new key');
  });
}
