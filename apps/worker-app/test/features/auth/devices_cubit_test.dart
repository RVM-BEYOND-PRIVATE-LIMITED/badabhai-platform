import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/devices_cubit.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

AuthDevice _device(String id, {bool isCurrent = false}) => AuthDevice(
      id: id,
      platform: 'android',
      model: 'Redmi 9A',
      appVersion: '1.0.0',
      trustedAt: DateTime.utc(2026, 7, 1),
      lastSeenAt: DateTime.utc(2026, 7, 17),
      isCurrent: isCurrent,
    );

/// #367 — the devices cubit is the worker's only "kick out a stolen phone"
/// control, and it had no tests. The load/revoke contract that matters: revoke
/// ALWAYS re-loads (the server list is the source of truth, never a local
/// splice), and a failed revoke must not leave a phantom removal on screen.
void main() {
  late MockAuthSessionManager manager;
  setUp(() => manager = MockAuthSessionManager());

  blocTest<DevicesCubit, DevicesState>(
    'load -> loading then ready with the server list',
    build: () {
      when(() => manager.listDevices()).thenAnswer(
        (_) async => <AuthDevice>[_device('d-1', isCurrent: true), _device('d-2')],
      );
      return DevicesCubit(manager);
    },
    act: (DevicesCubit c) => c.load(),
    expect: () => <DevicesState>[
      const DevicesState(status: DevicesStatus.loading),
      DevicesState(
        status: DevicesStatus.ready,
        devices: <AuthDevice>[_device('d-1', isCurrent: true), _device('d-2')],
      ),
    ],
  );

  // An empty list is a legitimate READY state, not a failure — the empty view
  // must be able to say "no other devices" honestly.
  blocTest<DevicesCubit, DevicesState>(
    'an empty server list resolves to ready, not failed',
    build: () {
      when(() => manager.listDevices()).thenAnswer((_) async => <AuthDevice>[]);
      return DevicesCubit(manager);
    },
    act: (DevicesCubit c) => c.load(),
    expect: () => const <DevicesState>[
      DevicesState(status: DevicesStatus.loading),
      DevicesState(status: DevicesStatus.ready),
    ],
  );

  // A shape drift must NEVER masquerade as "no devices" — contractError is the
  // honest-error path, so the empty view can distinguish it from a real empty.
  blocTest<DevicesCubit, DevicesState>(
    'an unreadable response fails explicitly with parse-honest copy',
    build: () {
      when(() => manager.listDevices())
          .thenThrow(const AuthFailure(AuthErrorCode.contractError));
      return DevicesCubit(manager, locale: 'en');
    },
    act: (DevicesCubit c) => c.load(),
    expect: () => const <DevicesState>[
      DevicesState(status: DevicesStatus.loading),
      DevicesState(
        status: DevicesStatus.failed,
        message: "Couldn't read the device list. Please try again.",
      ),
    ],
  );

  blocTest<DevicesCubit, DevicesState>(
    'an offline load says so — never a generic "something went wrong"',
    build: () {
      when(() => manager.listDevices())
          .thenThrow(const AuthFailure(AuthErrorCode.network));
      return DevicesCubit(manager, locale: 'en');
    },
    act: (DevicesCubit c) => c.load(),
    expect: () => const <DevicesState>[
      DevicesState(status: DevicesStatus.loading),
      DevicesState(
        status: DevicesStatus.failed,
        message: "Can't reach the server. Please try again.",
      ),
    ],
  );

  blocTest<DevicesCubit, DevicesState>(
    'a successful revoke re-loads and shows the server list without the device',
    build: () {
      when(() => manager.revokeDevice(any())).thenAnswer((_) async {});
      when(() => manager.listDevices())
          .thenAnswer((_) async => <AuthDevice>[_device('d-1', isCurrent: true)]);
      return DevicesCubit(manager);
    },
    act: (DevicesCubit c) => c.revoke('d-2'),
    expect: () => <DevicesState>[
      const DevicesState(status: DevicesStatus.loading),
      DevicesState(
        status: DevicesStatus.ready,
        devices: <AuthDevice>[_device('d-1', isCurrent: true)],
      ),
    ],
    verify: (_) {
      verify(() => manager.revokeDevice('d-2')).called(1);
      verify(() => manager.listDevices()).called(1);
    },
  );

  // A FAILED revoke must still re-load: the list is the source of truth, so the
  // device reappears rather than vanishing optimistically. A worker who thinks a
  // stolen phone was kicked off when it wasn't is the dangerous outcome.
  blocTest<DevicesCubit, DevicesState>(
    'a failed revoke re-loads, so the still-trusted device stays visible',
    build: () {
      when(() => manager.revokeDevice(any()))
          .thenThrow(const AuthFailure(AuthErrorCode.network));
      when(() => manager.listDevices()).thenAnswer(
        (_) async => <AuthDevice>[_device('d-1', isCurrent: true), _device('d-2')],
      );
      return DevicesCubit(manager);
    },
    act: (DevicesCubit c) => c.revoke('d-2'),
    expect: () => <DevicesState>[
      const DevicesState(status: DevicesStatus.loading),
      DevicesState(
        status: DevicesStatus.ready,
        // d-2 is STILL there — the revoke did not take.
        devices: <AuthDevice>[_device('d-1', isCurrent: true), _device('d-2')],
      ),
    ],
    verify: (_) => verify(() => manager.listDevices()).called(1),
  );

  // isClosed guards: the worker can pop the devices screen mid-request. An emit
  // on a closed cubit throws StateError in bloc 8.
  test('a load landing after close does not emit', () async {
    when(() => manager.listDevices()).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
      return <AuthDevice>[_device('d-1')];
    });
    final DevicesCubit cubit = DevicesCubit(manager);
    final Future<void> pending = cubit.load();
    await cubit.close();
    await expectLater(pending, completes);
    expect(cubit.state.status, DevicesStatus.loading);
    expect(cubit.state.devices, isEmpty);
  });

  test('a failed load landing after close does not emit', () async {
    when(() => manager.listDevices()).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
      throw const AuthFailure(AuthErrorCode.network);
    });
    final DevicesCubit cubit = DevicesCubit(manager, locale: 'en');
    final Future<void> pending = cubit.load();
    await cubit.close();
    await expectLater(pending, completes);
    expect(cubit.state.status, DevicesStatus.loading);
  });

  // #464 (FI-001) — THE crash that got the Settings entry point deleted instead
  // of fixed, stranding every worker with a stolen phone. load()'s first line is
  // `emit(loading)`, which looks synchronous and therefore safe; it is not.
  // revoke() awaits revokeDevice() and only THEN calls load(), so that emit is
  // reached after an await — and DevicesCubit is screen-scoped, so a worker who
  // confirms "Hatayein" and immediately backs out closes it mid-flight. The emit
  // then threw "Bad state: Cannot emit new states after calling close" out of
  // _DeviceTile._confirmRevoke.
  test('a revoke whose reload lands after close does not throw', () async {
    when(() => manager.revokeDevice(any())).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
    });
    when(() => manager.listDevices()).thenAnswer((_) async => <AuthDevice>[]);
    final DevicesCubit cubit = DevicesCubit(manager);

    final Future<void> pending = cubit.revoke('d-2');
    await cubit.close(); // the worker pops DevicesScreen mid-revoke
    await expectLater(pending, completes);

    // The revoke itself still went out — the stolen device IS kicked off; only
    // the dead cubit's UI refresh is skipped.
    verify(() => manager.revokeDevice('d-2')).called(1);
    // Nothing emitted, and no pointless re-fetch on a closed cubit.
    expect(cubit.state, const DevicesState());
    verifyNever(() => manager.listDevices());
  });

  test('load() called on an already-closed cubit is an inert no-op', () async {
    when(() => manager.listDevices())
        .thenAnswer((_) async => <AuthDevice>[_device('d-1')]);
    final DevicesCubit cubit = DevicesCubit(manager);
    await cubit.close();

    await expectLater(cubit.load(), completes);
    verifyNever(() => manager.listDevices());
  });

  // SECURITY (CLAUDE.md §2): device rows are opaque ids + platform metadata. No
  // phone number or worker name may ride along in what the cubit holds.
  test('device state carries only opaque ids and platform metadata', () async {
    when(() => manager.listDevices())
        .thenAnswer((_) async => <AuthDevice>[_device('d-1', isCurrent: true)]);
    final DevicesCubit cubit = DevicesCubit(manager);
    await cubit.load();
    final String dump = cubit.state.devices.first.props.join('|');
    expect(dump, isNot(matches(RegExp(r'\d{10}')))); // no bare phone number
    expect(dump, isNot(contains('+91')));
    await cubit.close();
  });
}
