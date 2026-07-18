import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/enter_pin_cubit.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// #367 — the lock screen's cubit had ZERO unit tests: its re-entrancy guard,
/// its `isClosed` guards, and the client-side soft-fail counter that flips
/// `suggestForgot` at exactly 3 were all unverified, so an off-by-one or a
/// dropped guard would ship green. That counter is the ONLY forgot-PIN nudge a
/// returning worker gets — the backend deliberately answers every PIN failure
/// with one neutral 401 (no attempts-left, no retry-after), so there is nothing
/// server-side to fall back on.
void main() {
  late MockAuthSessionManager manager;
  setUp(() => manager = MockAuthSessionManager());

  const AuthFailure pinFailed = AuthFailure(AuthErrorCode.pinVerifyFailed,
      statusCode: 401);
  // The neutral copy the backend's opaque 401 maps to (en locale).
  const String neutralCopy = "PIN didn't match — try again, or tap 'Forgot PIN?'";

  blocTest<EnterPinCubit, EnterPinState>(
    'a correct PIN -> submitting then done',
    build: () {
      when(() => manager.unlockWithPin(any())).thenAnswer((_) async {});
      return EnterPinCubit(manager);
    },
    act: (EnterPinCubit c) => c.unlock('7416'),
    expect: () => const <EnterPinState>[
      EnterPinState(status: EnterPinStatus.submitting),
      EnterPinState(status: EnterPinStatus.done),
    ],
    verify: (_) => verify(() => manager.unlockWithPin('7416')).called(1),
  );

  blocTest<EnterPinCubit, EnterPinState>(
    'a wrong PIN -> neutral localized copy, and NO forgot nudge on the first miss',
    build: () {
      when(() => manager.unlockWithPin(any())).thenThrow(pinFailed);
      return EnterPinCubit(manager, locale: 'en');
    },
    act: (EnterPinCubit c) => c.unlock('7416'),
    expect: () => const <EnterPinState>[
      EnterPinState(status: EnterPinStatus.submitting),
      // suggestForgot stays false: nudging on miss #1 would read as an accusation.
      EnterPinState(status: EnterPinStatus.failure, message: neutralCopy),
    ],
  );

  // The threshold is the whole feature. Asserting the FULL state sequence over
  // three misses pins it at exactly 3 in both directions — a `>` / `>=` slip or
  // a threshold bumped to 2 or 4 breaks this test, not just production.
  blocTest<EnterPinCubit, EnterPinState>(
    'suggestForgot flips on the 3rd failure — not the 2nd',
    build: () {
      when(() => manager.unlockWithPin(any())).thenThrow(pinFailed);
      return EnterPinCubit(manager, locale: 'en');
    },
    act: (EnterPinCubit c) async {
      await c.unlock('7416');
      await c.unlock('7417');
      await c.unlock('7418');
    },
    expect: () => const <EnterPinState>[
      EnterPinState(status: EnterPinStatus.submitting),
      EnterPinState(status: EnterPinStatus.failure, message: neutralCopy),
      EnterPinState(status: EnterPinStatus.submitting),
      EnterPinState(status: EnterPinStatus.failure, message: neutralCopy),
      EnterPinState(status: EnterPinStatus.submitting),
      EnterPinState(
        status: EnterPinStatus.failure,
        message: neutralCopy,
        suggestForgot: true,
      ),
    ],
  );

  // NO ORACLE: every failure must look identical to the worker. If a future
  // change started leaking "2 attempts left" into the copy, the backend's
  // deliberate neutrality would be undone client-side.
  test('every failure carries the SAME copy — no attempts-left oracle', () async {
    when(() => manager.unlockWithPin(any())).thenThrow(pinFailed);
    final EnterPinCubit cubit = EnterPinCubit(manager, locale: 'en');
    final List<String?> messages = <String?>[];
    for (int i = 0; i < 4; i++) {
      await cubit.unlock('7416');
      messages.add(cubit.state.message);
    }
    expect(messages.toSet(), <String>{neutralCopy});
    await cubit.close();
  });

  // The forgot nudge is sticky: once shown it must survive the next in-flight
  // state, or the link would flicker away exactly when the worker reaches for it.
  blocTest<EnterPinCubit, EnterPinState>(
    'an in-flight retry after the nudge keeps suggestForgot set',
    build: () {
      when(() => manager.unlockWithPin(any())).thenThrow(pinFailed);
      return EnterPinCubit(manager, locale: 'en');
    },
    act: (EnterPinCubit c) async {
      await c.unlock('7416');
      await c.unlock('7416');
      await c.unlock('7416'); // nudge on
      await c.unlock('7416'); // 4th: submitting must still carry the nudge
    },
    skip: 6, // the first three rounds are asserted above
    expect: () => const <EnterPinState>[
      EnterPinState(status: EnterPinStatus.submitting, suggestForgot: true),
      EnterPinState(
        status: EnterPinStatus.failure,
        message: neutralCopy,
        suggestForgot: true,
      ),
    ],
  );

  // Re-entrancy: a double-tap on the keypad's confirm must not fire two unlock
  // attempts. Each attempt ROTATES the refresh token server-side, so a duplicate
  // in-flight call races the rotation and can invalidate the session.
  blocTest<EnterPinCubit, EnterPinState>(
    'a double unlock while in flight only calls the manager once',
    build: () {
      when(() => manager.unlockWithPin(any())).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      return EnterPinCubit(manager);
    },
    act: (EnterPinCubit c) {
      c.unlock('7416'); // in flight
      c.unlock('7416'); // dropped by the isSubmitting guard
    },
    wait: const Duration(milliseconds: 80),
    expect: () => const <EnterPinState>[
      EnterPinState(status: EnterPinStatus.submitting),
      EnterPinState(status: EnterPinStatus.done),
    ],
    verify: (_) => verify(() => manager.unlockWithPin('7416')).called(1),
  );

  // The guard must RELEASE on failure — otherwise one wrong PIN would freeze the
  // lock screen forever (the worst possible dead-end for a returning worker).
  test('the guard releases after a failure so the worker can retry', () async {
    when(() => manager.unlockWithPin(any())).thenThrow(pinFailed);
    final EnterPinCubit cubit = EnterPinCubit(manager, locale: 'en');
    await cubit.unlock('7416');
    expect(cubit.state.isSubmitting, isFalse);
    await cubit.unlock('7417');
    verify(() => manager.unlockWithPin(any())).called(2);
    await cubit.close();
  });

  // isClosed guards: the worker can navigate off the lock screen (forgot-PIN)
  // mid-request. An emit on a closed cubit throws StateError in bloc 8, so these
  // two tests fail loudly if either guard is dropped.
  test('a success landing after close does not emit', () async {
    when(() => manager.unlockWithPin(any())).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
    });
    final EnterPinCubit cubit = EnterPinCubit(manager);
    final Future<void> pending = cubit.unlock('7416');
    await cubit.close();
    await expectLater(pending, completes);
    expect(cubit.state.status, EnterPinStatus.submitting); // never advanced
  });

  test('a failure landing after close does not emit', () async {
    when(() => manager.unlockWithPin(any())).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
      throw pinFailed;
    });
    final EnterPinCubit cubit = EnterPinCubit(manager, locale: 'en');
    final Future<void> pending = cubit.unlock('7416');
    await cubit.close();
    await expectLater(pending, completes);
    expect(cubit.state.status, EnterPinStatus.submitting);
  });

  // SECURITY (CLAUDE.md §2): the cubit is a pass-through — it must never park the
  // PIN in state where a screenshot, an error overlay or a state dump could
  // surface it.
  test('the PIN never lands in cubit state', () async {
    when(() => manager.unlockWithPin(any())).thenThrow(pinFailed);
    final EnterPinCubit cubit = EnterPinCubit(manager, locale: 'en');
    await cubit.unlock('7416');
    expect(cubit.state.props.join('|'), isNot(contains('7416')));
    expect(cubit.state.message, isNot(contains('7416')));
    await cubit.close();
  });

  // #367 — this was originally written as a CHARACTERIZATION test pinning a
  // dead-end: the cubit caught only AuthFailure, so a PlatformException from the
  // Keystore-backed secure store (unlockWithPin persists/reads/bridges) escaped,
  // left the state stuck on `submitting`, and the isSubmitting guard then
  // rejected every later attempt — a permanently dead lock screen with no way
  // back into the app. The cubit has since grown the generic catch, so this now
  // asserts the FIX: a non-AuthFailure must fail RECOVERABLY.
  test('a non-AuthFailure fails recoverably — never wedges the guard', () async {
    when(() => manager.unlockWithPin(any()))
        .thenThrow(StateError('secure storage unavailable'));
    final EnterPinCubit cubit = EnterPinCubit(manager, locale: 'en');

    // Does not throw out of the cubit, and does not strand `submitting`.
    await cubit.unlock('7416');
    expect(cubit.state.isSubmitting, isFalse,
        reason: 'a stranded submitting state permanently blocks retries');
    expect(cubit.state.status, EnterPinStatus.failure);
    expect(cubit.state.message, isNotEmpty, reason: 'say something honest');

    // The guard has re-armed: a retry genuinely reaches the manager again.
    await cubit.unlock('7416');
    verify(() => manager.unlockWithPin(any())).called(2);

    // A storage fault is NOT the worker's fault, so it must not push them toward
    // the forgot-PIN flow the way repeated WRONG PINs do.
    expect(cubit.state.suggestForgot, isFalse);
    await cubit.close();
  });
}
