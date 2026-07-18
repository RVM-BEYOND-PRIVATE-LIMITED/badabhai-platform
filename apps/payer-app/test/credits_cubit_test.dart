import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/session/credits_cubit.dart';

/// #189 fast-follow — CreditsCubit must NEVER mask a fetch failure as a real
/// "0 credits": on error it keeps the last-known balance and flags `error`, so
/// the Home stat / unlock-dialog math render '—', not 0, during an outage.
class _ScriptedApi extends MockPayerApiClient {
  bool failBalance = false;
  bool failUnlock = false;
  int balanceReads = 0;

  @override
  Future<int> fetchCreditBalance() async {
    balanceReads++;
    if (failBalance) throw PayerApiException(500);
    return super.fetchCreditBalance();
  }

  @override
  Future<int> unlockCandidate(int candidateId) async {
    if (failUnlock) throw PayerApiException(500);
    return super.unlockCandidate(candidateId);
  }
}

void main() {
  late _ScriptedApi api;
  late CreditsCubit cubit;

  setUp(() {
    api = _ScriptedApi();
    cubit = CreditsCubit(api);
  });

  tearDown(() => cubit.close());

  test('initial state: unknown balance (null), no error', () {
    expect(cubit.state.balance, isNull);
    expect(cubit.state.error, isFalse);
  });

  test('load rides the GUARDED fetchCreditBalance and emits server truth',
      () async {
    await cubit.load();
    expect(cubit.state.error, isFalse);
    expect(cubit.state.balance, await api.fetchCreditBalance());
    expect(api.balanceReads, greaterThanOrEqualTo(1));
  });

  test('load failure with NO prior balance → error + balance stays null '
      '(NEVER a fabricated 0)', () async {
    api.failBalance = true;
    await cubit.load();
    expect(cubit.state.error, isTrue);
    expect(cubit.state.balance, isNull);
    expect(cubit.state.balance, isNot(0));
  });

  test('load failure AFTER a good load keeps the last-known balance + error',
      () async {
    await cubit.load();
    final int? known = cubit.state.balance;
    expect(known, isNotNull);

    api.failBalance = true;
    await cubit.load();

    expect(cubit.state.error, isTrue);
    expect(cubit.state.balance, known); // kept — no data loss, no 0-mask
  });

  test('a later successful load clears the error flag', () async {
    api.failBalance = true;
    await cubit.load();
    expect(cubit.state.error, isTrue);

    api.failBalance = false;
    await cubit.load();

    expect(cubit.state.error, isFalse);
    expect(cubit.state.balance, isNotNull);
  });

  test('unlock spends 1 and re-reads server truth (guarded)', () async {
    await cubit.load();
    final int before = cubit.state.balance!;

    await cubit.unlock(1);

    expect(cubit.state.error, isFalse);
    expect(cubit.state.balance, before - 1);
  });

  test('unlock failure → error + last-known balance kept, never 0', () async {
    await cubit.load();
    final int? known = cubit.state.balance;

    api.failUnlock = true;
    await cubit.unlock(1);

    expect(cubit.state.error, isTrue);
    expect(cubit.state.balance, known);
  });

  // #369 — this cubit is an app-wide lazySingleton, so its state survives
  // sign-out. Without reset, the next payer to sign in on a shared device reads
  // the previous payer's balance — and because the failure path above KEEPS the
  // last-known value, a failed first fetch leaves it on screen indefinitely.
  group('reset on sign-out (#369)', () {
    test('drops a loaded balance back to unknown', () async {
      await cubit.load();
      expect(cubit.state.balance, isNotNull);

      cubit.reset();

      expect(cubit.state.balance, isNull,
          reason: "the next payer must start at '—', not payer A's number");
      expect(cubit.state.error, isFalse);
    });

    test('a failed load AFTER reset cannot resurrect the previous balance',
        () async {
      await cubit.load(); // payer A's balance is now last-known
      cubit.reset(); // payer A signs out

      api.failBalance = true;
      await cubit.load(); // payer B signs in; first fetch fails

      expect(cubit.state.error, isTrue);
      expect(cubit.state.balance, isNull,
          reason: "payer A's balance must not be retained as B's last-known");
    });
  });
}
