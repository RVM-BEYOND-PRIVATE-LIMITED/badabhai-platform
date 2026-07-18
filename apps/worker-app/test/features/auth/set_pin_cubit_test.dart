import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/set_pin_cubit.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// #367 — set-PIN is the one-way door of onboarding: it runs immediately after
/// OTP, and `setPin` flips the manager to authenticated. Its re-entrancy guard
/// and isClosed guards were untested, so a double-tap firing two pin/set calls
/// (or an emit on a disposed cubit) would ship green.
void main() {
  late MockAuthSessionManager manager;
  setUp(() => manager = MockAuthSessionManager());

  blocTest<SetPinCubit, SetPinState>(
    'a valid PIN -> submitting then done',
    build: () {
      when(() => manager.setPin(any())).thenAnswer((_) async {});
      return SetPinCubit(manager);
    },
    act: (SetPinCubit c) => c.submit('7416'),
    expect: () => const <SetPinState>[
      SetPinState(status: SetPinStatus.submitting),
      SetPinState(status: SetPinStatus.done),
    ],
    verify: (_) => verify(() => manager.setPin('7416')).called(1),
  );

  // The SERVER is the weak-PIN policy authority (isWeakPin is only a pre-submit
  // hint). A 400 → pinWeak must surface as readable copy, not a dead spinner.
  blocTest<SetPinCubit, SetPinState>(
    'a server weak-PIN rejection surfaces the localized weak-PIN copy',
    build: () {
      when(() => manager.setPin(any()))
          .thenThrow(const AuthFailure(AuthErrorCode.pinWeak, statusCode: 400));
      return SetPinCubit(manager, locale: 'en');
    },
    act: (SetPinCubit c) => c.submit('1234'),
    expect: () => const <SetPinState>[
      SetPinState(status: SetPinStatus.submitting),
      SetPinState(
        status: SetPinStatus.failure,
        message: 'That PIN is too weak. Please choose a stronger one.',
      ),
    ],
  );

  // pinWeak is one of the few codes where the server message is meaningful and
  // safe to show verbatim (it names the actual rule the worker broke).
  blocTest<SetPinCubit, SetPinState>(
    'a meaningful server weak-PIN message is preferred over the generic copy',
    build: () {
      when(() => manager.setPin(any())).thenThrow(const AuthFailure(
        AuthErrorCode.pinWeak,
        statusCode: 400,
        message: 'PIN must not repeat a digit four times',
      ));
      return SetPinCubit(manager, locale: 'en');
    },
    act: (SetPinCubit c) => c.submit('1111'),
    expect: () => const <SetPinState>[
      SetPinState(status: SetPinStatus.submitting),
      SetPinState(
        status: SetPinStatus.failure,
        message: 'PIN must not repeat a digit four times',
      ),
    ],
  );

  blocTest<SetPinCubit, SetPinState>(
    'a network failure surfaces the honest offline copy, never a silent stall',
    build: () {
      when(() => manager.setPin(any()))
          .thenThrow(const AuthFailure(AuthErrorCode.network));
      return SetPinCubit(manager, locale: 'en');
    },
    act: (SetPinCubit c) => c.submit('7416'),
    expect: () => const <SetPinState>[
      SetPinState(status: SetPinStatus.submitting),
      SetPinState(
        status: SetPinStatus.failure,
        message: "Can't reach the server. Please try again.",
      ),
    ],
  );

  // Re-entrancy: two pin/set calls from one double-tap would race, and the
  // second could land after the first already authenticated the session.
  blocTest<SetPinCubit, SetPinState>(
    'a double submit while in flight only calls the manager once',
    build: () {
      when(() => manager.setPin(any())).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      return SetPinCubit(manager);
    },
    act: (SetPinCubit c) {
      c.submit('7416'); // in flight
      c.submit('7416'); // dropped by the isSubmitting guard
    },
    wait: const Duration(milliseconds: 80),
    expect: () => const <SetPinState>[
      SetPinState(status: SetPinStatus.submitting),
      SetPinState(status: SetPinStatus.done),
    ],
    verify: (_) => verify(() => manager.setPin('7416')).called(1),
  );

  // The guard must release on failure, or one rejected PIN would freeze the
  // screen with no way forward and no way back (onboarding dead-end).
  test('the guard releases after a failure so the worker can pick another PIN',
      () async {
    when(() => manager.setPin(any()))
        .thenThrow(const AuthFailure(AuthErrorCode.pinWeak));
    final SetPinCubit cubit = SetPinCubit(manager, locale: 'en');
    await cubit.submit('1234');
    expect(cubit.state.isSubmitting, isFalse);
    await cubit.submit('7416');
    verify(() => manager.setPin(any())).called(2);
    await cubit.close();
  });

  // isClosed guards — an emit on a closed cubit throws StateError in bloc 8, so
  // dropping either guard fails these loudly.
  test('a success landing after close does not emit', () async {
    when(() => manager.setPin(any())).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
    });
    final SetPinCubit cubit = SetPinCubit(manager);
    final Future<void> pending = cubit.submit('7416');
    await cubit.close();
    await expectLater(pending, completes);
    expect(cubit.state.status, SetPinStatus.submitting);
  });

  test('a failure landing after close does not emit', () async {
    when(() => manager.setPin(any())).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
      throw const AuthFailure(AuthErrorCode.pinWeak);
    });
    final SetPinCubit cubit = SetPinCubit(manager, locale: 'en');
    final Future<void> pending = cubit.submit('1234');
    await cubit.close();
    await expectLater(pending, completes);
    expect(cubit.state.status, SetPinStatus.submitting);
  });

  // SECURITY (CLAUDE.md §2): the chosen PIN is forwarded and dropped — it must
  // never be parked in state.
  test('the chosen PIN never lands in cubit state', () async {
    when(() => manager.setPin(any()))
        .thenThrow(const AuthFailure(AuthErrorCode.pinWeak));
    final SetPinCubit cubit = SetPinCubit(manager, locale: 'en');
    await cubit.submit('7416');
    expect(cubit.state.props.join('|'), isNot(contains('7416')));
    await cubit.close();
  });
}
