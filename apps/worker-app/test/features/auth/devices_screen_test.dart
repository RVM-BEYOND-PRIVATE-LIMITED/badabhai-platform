import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_error_messages.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_card.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_docked_bar.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/devices_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/devices_screen.dart';

import '../../support/kit_matrix.dart';

class _MockAuthSessionManager extends Mock implements AuthSessionManager {}

AuthDevice _device(
  String id, {
  bool isCurrent = false,
  String platform = 'android',
  String? model = 'Redmi 9A',
}) => AuthDevice(
  id: id,
  platform: platform,
  model: model,
  appVersion: '1.0.0',
  trustedAt: DateTime.utc(2026, 7, 1),
  lastSeenAt: DateTime.now().subtract(const Duration(hours: 3)),
  isCurrent: isCurrent,
);

/// The screen had NO widget test: it is the worker's only in-app way to kick a
/// stolen phone off their account, and every guarantee below (the panic button
/// survives a failed list, a revoke blocks its siblings, 'ios' is not shown as a
/// raw platform token) was previously unpinned.
void main() {
  late _MockAuthSessionManager manager;

  setUp(() async {
    manager = _MockAuthSessionManager();
    await locator.reset();
    // A screen-scoped factory, exactly as the real graph registers it — the
    // screen resolves the cubit itself.
    locator.registerFactory<DevicesCubit>(
      () => DevicesCubit(manager, locale: 'en'),
    );
    when(() => manager.listDevices()).thenAnswer(
      (_) async => <AuthDevice>[
        _device('d-1', isCurrent: true),
        _device('d-2', model: 'Pixel 6'),
      ],
    );
    when(() => manager.logoutAll()).thenAnswer((_) async {});
  });

  tearDown(() async {
    bottomBarInset.value = 0;
    await locator.reset();
  });

  Future<void> pump(WidgetTester tester, {double textScale = 1.0}) async {
    await tester.pumpWidget(
      kitTestApp(const DevicesScreen(), textScale: textScale),
    );
    await tester.pump(); // load() resolves
  }

  testWidgets('the navy header carries the title and a back affordance', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    expect(find.text('Aapke devices'), findsOneWidget);
    expect(find.byTooltip('Wapas'), findsOneWidget);
  });

  testWidgets('a pending list shows the spinner, not an empty list', (
    WidgetTester tester,
  ) async {
    final Completer<List<AuthDevice>> pending = Completer<List<AuthDevice>>();
    when(() => manager.listDevices()).thenAnswer((_) => pending.future);

    await pump(tester);

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byType(KitCard), findsNothing);

    pending.complete(<AuthDevice>[_device('d-1', isCurrent: true)]);
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets(
    'a failed load shows the cubit\'s honest reason AND keeps the panic '
    'button reachable',
    (WidgetTester tester) async {
      when(
        () => manager.listDevices(),
      ).thenThrow(const AuthFailure(AuthErrorCode.contractError));

      await pump(tester);

      expect(find.text('Devices load nahi hue.'), findsOneWidget);
      // The REAL message, not a generic "check internet".
      expect(
        find.text(
          authErrorMessage(
            const AuthFailure(AuthErrorCode.contractError),
            'en',
          ),
        ),
        findsOneWidget,
      );
      expect(find.text('Try again'), findsOneWidget);
      // A worker whose phone was stolen must be able to sign everything out
      // even when the list itself could not load.
      expect(find.text('Sabhi devices se logout'), findsOneWidget);
    },
  );

  testWidgets('empty is not failed — it says "only this phone"', (
    WidgetTester tester,
  ) async {
    when(() => manager.listDevices()).thenAnswer((_) async => <AuthDevice>[]);

    await pump(tester);

    expect(find.text('Koi doosra device nahi.'), findsOneWidget);
    expect(find.text('Devices load nahi hue.'), findsNothing);
  });

  testWidgets(
    'the current device wears the "Yeh phone" pill and cannot be removed',
    (WidgetTester tester) async {
      await pump(tester);

      expect(find.text('Yeh phone'), findsOneWidget);
      // Exactly one revoke control: the OTHER device's.
      expect(find.widgetWithText(TextButton, 'Hatayein'), findsOneWidget);
      expect(find.text('Android · Redmi 9A'), findsOneWidget);
      expect(find.text('Android · Pixel 6'), findsOneWidget);
    },
  );

  testWidgets('a revoke in flight blocks every other tile and shows a spinner', (
    WidgetTester tester,
  ) async {
    when(() => manager.listDevices()).thenAnswer(
      (_) async => <AuthDevice>[
        _device('d-1', isCurrent: true),
        _device('d-2', model: 'Pixel 6'),
        _device('d-3', model: 'Galaxy M13'),
      ],
    );
    final Completer<void> revoke = Completer<void>();
    when(() => manager.revokeDevice(any())).thenAnswer((_) => revoke.future);

    await pump(tester);
    expect(find.widgetWithText(TextButton, 'Hatayein'), findsNWidgets(2));

    await tester.tap(find.widgetWithText(TextButton, 'Hatayein').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // The confirm is the kit dialog; tap ITS action, not the row button.
    expect(find.text('Device hatayein?'), findsOneWidget);
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Hatayein'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    verify(() => manager.revokeDevice('d-2')).called(1);
    // The revoking row shows a spinner…
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    // …and the remaining row's action is disabled, so a second tap cannot fire
    // a duplicate revoke.
    final TextButton other = tester.widget<TextButton>(
      find.widgetWithText(TextButton, 'Hatayein'),
    );
    expect(other.onPressed, isNull);

    when(() => manager.listDevices()).thenAnswer(
      (_) async => <AuthDevice>[
        _device('d-1', isCurrent: true),
        _device('d-3', model: 'Galaxy M13'),
      ],
    );
    revoke.complete();
    await tester.pump();
    await tester.pump();

    expect(find.text('Android · Pixel 6'), findsNothing);
    expect(find.text('Android · Galaxy M13'), findsOneWidget);
  });

  testWidgets(
    'logout-all confirms with the approved copy, cannot be tapped past, and '
    'then signs every device out',
    (WidgetTester tester) async {
      await pump(tester);

      await tester.tap(find.text('Sabhi devices se logout'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Sabhi devices se logout?'), findsOneWidget);
      expect(
        find.textContaining('Aap sabhi phone aur devices se'),
        findsOneWidget,
      );

      // barrierDismissible: false — a tap outside must NOT dismiss it.
      await tester.tapAt(const Offset(8, 8));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Sabhi devices se logout?'), findsOneWidget);

      await tester.tap(find.text('Logout karein'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      verify(() => manager.logoutAll()).called(1);
    },
  );

  testWidgets(
    'the platform token is humanized — never "Ios", never a raw id on screen',
    (WidgetTester tester) async {
      when(() => manager.listDevices()).thenAnswer(
        (_) async => <AuthDevice>[
          _device('d-1', isCurrent: true, platform: 'ios', model: null),
          _device('d-2', platform: '', model: null),
          _device('d-3', platform: 'windows', model: 'Surface'),
        ],
      );

      await pump(tester);

      expect(find.text('iPhone'), findsOneWidget);
      expect(find.text('Device'), findsOneWidget);
      expect(find.text('Windows · Surface'), findsOneWidget);
      expect(find.text('Ios'), findsNothing);

      // D11 — no raw wire token or opaque id is ever rendered.
      for (final Text t in tester.widgetList<Text>(find.byType(Text))) {
        final String s = t.data ?? '';
        expect(s.contains('d-1'), isFalse, reason: 'no device id on screen');
        expect(s.contains('d-2'), isFalse, reason: 'no device id on screen');
        expect(s, isNot('ios'));
        expect(s, isNot('android'));
      }
    },
  );

  testWidgets('the docked bar publishes its own height as the FAB inset', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(390, 844));
    await tester.pumpWidget(kitTestApp(const DevicesScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final double barHeight = tester.getSize(find.byType(KitDockedBar)).height;
    expect(bottomBarInset.value, barHeight);
    // A bar, not the whole screen: the inset is what the Feedback pill floats
    // above, so a screen-height value would push the pill off the display.
    expect(barHeight, lessThan(160));
  });

  testWidgets('at 768 the card column stops instead of stretching', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(const DevicesScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(widthOf(tester, find.byType(KitCard).first), lessThanOrEqualTo(440));
  });

  testWidgets('every control clears the 48dp touch floor', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(const DevicesScreen()));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await expectKitTapTargets(tester);
  });

  group('matrix', () {
    kitMatrixTest(
      'devices list',
      () => const DevicesScreen(),
      primary: () => find.text('Sabhi devices se logout'),
    );
  });
}
