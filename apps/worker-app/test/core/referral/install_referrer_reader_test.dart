// B4 attribution — the Play Install Referrer leg.
//
// A worker who taps an invite link WITHOUT the app installed goes to Play, and
// the referral used to die there: the install carries no deep-link intent, so
// PendingReferralStore stayed empty and the inviting agent was never credited.
// These lock the three things that make the recovery safe: it parses the code,
// it fires exactly once, and it is silent on every failure path.

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/referral/install_referrer_reader.dart';
import 'package:badabhai_worker_app/core/referral/pending_referral_store.dart';

const String _code = 'abcdef012345';

/// Counts how many times the referrer was actually asked for — the consume-once
/// guard is about THIS number, not just about the store's contents.
class _CountingFetch {
  _CountingFetch(this._value, {this.throws = false});

  final String? _value;
  final bool throws;
  int calls = 0;

  Future<String?> call() async {
    calls++;
    if (throws) throw StateError('Play Store not available');
    return _value;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late InMemoryPendingReferralStore store;

  setUp(() {
    store = InMemoryPendingReferralStore();
    SharedPreferences.setMockInitialValues(<String, Object>{});
  });

  InstallReferrerReader reader(_CountingFetch fetch) => InstallReferrerReader(
        store: store,
        fetch: fetch.call,
      );

  // --- Parsing --------------------------------------------------------------

  group('referralCodeFromInstallReferrer', () {
    test('plain query string', () {
      expect(referralCodeFromInstallReferrer('bb_code=$_code'), _code);
    });

    test('alongside the usual utm params, in any position', () {
      expect(
        referralCodeFromInstallReferrer(
            'utm_source=whatsapp&bb_code=$_code&utm_medium=share'),
        _code,
      );
      expect(
        referralCodeFromInstallReferrer('bb_code=$_code&utm_source=whatsapp'),
        _code,
      );
    });

    test('percent-encoded referrer (how Play often hands it back)', () {
      expect(
        referralCodeFromInstallReferrer(
            'utm_source%3Dwhatsapp%26bb_code%3D$_code'),
        _code,
      );
    });

    test('no bb_code → null (an organic install is the common case)', () {
      expect(
        referralCodeFromInstallReferrer('utm_source=google-play&utm_medium=organic'),
        isNull,
      );
    });

    test('junk never throws — it is just "no code"', () {
      expect(referralCodeFromInstallReferrer(null), isNull);
      expect(referralCodeFromInstallReferrer(''), isNull);
      expect(referralCodeFromInstallReferrer('   '), isNull);
      expect(referralCodeFromInstallReferrer('%%%not-a-query%%%'), isNull);
      expect(referralCodeFromInstallReferrer('bb_code='), isNull);
      expect(referralCodeFromInstallReferrer('{"json":"not a referrer"}'), isNull);
    });

    test('extraction does not shape-validate — the store is the one validator',
        () {
      // Mirrors referralCodeFromUri: the 12-hex rule lives in
      // PendingReferralStore.capture so it can never drift between the deep-link
      // and install-referrer entry points.
      expect(referralCodeFromInstallReferrer('bb_code=NOT-A-CODE'), 'NOT-A-CODE');
    });
  });

  // --- Capture --------------------------------------------------------------

  group('consumeOnce', () {
    test('a valid code lands in the SAME store consent already drains',
        () async {
      final _CountingFetch fetch = _CountingFetch('bb_code=$_code');
      await reader(fetch).consumeOnce();

      expect(await store.take(), _code);
    });

    test('a malformed code is dropped by the store, not stored', () async {
      final _CountingFetch fetch = _CountingFetch('bb_code=NOT-A-CODE');
      await reader(fetch).consumeOnce();

      expect(await store.take(), isNull);
    });

    test('a missing referrer leaves the store untouched', () async {
      final _CountingFetch fetch = _CountingFetch(null);
      await reader(fetch).consumeOnce();

      expect(await store.take(), isNull);
    });

    test('a garbage referrer leaves the store untouched', () async {
      final _CountingFetch fetch = _CountingFetch('%%%garbage%%%');
      await reader(fetch).consumeOnce();

      expect(await store.take(), isNull);
    });
  });

  // --- The consume-once guard ----------------------------------------------

  group('consume-once guard', () {
    test('a second launch does not ask Play again, and does not re-capture',
        () async {
      final _CountingFetch fetch = _CountingFetch('bb_code=$_code');
      await reader(fetch).consumeOnce();
      expect(await store.take(), _code); // consumed by consent, as in production

      // Cold start #2 — a fresh reader over the SAME persisted prefs.
      await reader(fetch).consumeOnce();

      expect(fetch.calls, 1, reason: 'the referrer is read once per install');
      expect(await store.take(), isNull,
          reason: 'a 90-day-old referrer must never re-attribute a worker');
    });

    test('the flag is persisted, so it survives a process restart', () async {
      final _CountingFetch fetch = _CountingFetch('bb_code=$_code');
      await reader(fetch).consumeOnce();

      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(prefs.getBool(InstallReferrerReader.kConsumedKey), isTrue);
    });

    test('"no referrer" still counts as the one look', () async {
      final _CountingFetch fetch = _CountingFetch(null);
      await reader(fetch).consumeOnce();
      await reader(fetch).consumeOnce();

      expect(fetch.calls, 1);
    });

    test(
        'a THROWN fetch is not an answer — it does not burn the one look',
        () async {
      final _CountingFetch failing =
          _CountingFetch(null, throws: true); // e.g. Play Services down
      await reader(failing).consumeOnce();
      expect(failing.calls, 1);

      // A later launch may try again, and succeeds.
      final _CountingFetch ok = _CountingFetch('bb_code=$_code');
      await reader(ok).consumeOnce();
      expect(ok.calls, 1);
      expect(await store.take(), _code);
    });

    test('a throwing fetch never surfaces — first launch is never blocked',
        () async {
      final _CountingFetch failing = _CountingFetch(null, throws: true);
      await expectLater(reader(failing).consumeOnce(), completes);
      expect(await store.take(), isNull);
    });
  });

  // --- Deep link wins -------------------------------------------------------

  test(
      'a code already captured from a deep link is NOT clobbered by the '
      'install referrer', () async {
    // The worker tapped /i/<deepLink> in THIS session; the install referrer is a
    // record of some earlier click, so the fresh one must win.
    const String deepLinkCode = 'ffffffffffff';
    SharedPreferences.setMockInitialValues(<String, Object>{
      SharedPrefsPendingReferralStore.kKey: deepLinkCode,
    });
    const SharedPrefsPendingReferralStore prefsStore =
        SharedPrefsPendingReferralStore();
    final _CountingFetch fetch = _CountingFetch('bb_code=$_code');

    await InstallReferrerReader(store: prefsStore, fetch: fetch.call)
        .consumeOnce();

    expect(await prefsStore.take(), deepLinkCode);
    expect(fetch.calls, 0, reason: 'no need to ask Play — a code is pending');
  });
}
