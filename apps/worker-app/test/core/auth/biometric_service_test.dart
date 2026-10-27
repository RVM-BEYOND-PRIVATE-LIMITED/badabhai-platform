import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:local_auth/local_auth.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/biometric_service.dart';

class MockLocalAuthentication extends Mock implements LocalAuthentication {}

void main() {
  setUpAll(() => registerFallbackValue(const AuthenticationOptions()));

  test(
    'a HUNG OS prompt is bounded and returns failed (PIN stays reachable)',
    () async {
      final MockLocalAuthentication auth = MockLocalAuthentication();
      when(() => auth.isDeviceSupported()).thenAnswer((_) async => true);
      when(() => auth.canCheckBiometrics).thenAnswer((_) async => true);
      when(
        () => auth.getAvailableBiometrics(),
      ).thenAnswer((_) async => <BiometricType>[BiometricType.face]);
      // A wedged platform channel: the prompt never completes.
      when(
        () => auth.authenticate(
          localizedReason: any(named: 'localizedReason'),
          options: any(named: 'options'),
        ),
      ).thenAnswer((_) => Completer<bool>().future);

      final LocalAuthBiometricService service = LocalAuthBiometricService(
        auth,
        const Duration(milliseconds: 20),
      );

      expect(
        await service.authenticate(reason: 'unlock'),
        BiometricUnlockResult.failed,
        reason: 'a hung prompt must not pin the UI behind the loader forever',
      );
    },
  );
}
