import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/suspended/presentation/suspended_account_screen.dart';

Future<void> _pump(WidgetTester tester, {String? token}) async {
  tester.view.physicalSize = const Size(800, 1400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(home: SuspendedAccountScreen(restrictedToken: token)),
  );
}

void main() {
  testWidgets('always renders the message and support contact', (tester) async {
    await _pump(tester);
    await tester.pump(kSuspendedScreenFadeDuration);

    expect(find.text(kSuspendedTitle), findsOneWidget);
    expect(find.text(kSuspendedMessage), findsOneWidget);
    expect(find.text(kSuspendedSupport), findsOneWidget);
  });

  testWidgets(
    'NO restricted token -> no delete/withdraw buttons (no dead UI)',
    (tester) async {
      await _pump(tester);
      await tester.pump(kSuspendedScreenFadeDuration);

      expect(find.byKey(kSuspendedDeleteButtonKey), findsNothing);
      expect(find.byKey(kSuspendedWithdrawButtonKey), findsNothing);
    },
  );

  testWidgets('a restricted token reveals both DPDP exits', (tester) async {
    await _pump(tester, token: 'restricted-1');
    await tester.pump(kSuspendedScreenFadeDuration);

    expect(find.byKey(kSuspendedDeleteButtonKey), findsOneWidget);
    expect(find.byKey(kSuspendedWithdrawButtonKey), findsOneWidget);
  });

  testWidgets('fades in over 200ms (no shake / error haptic)', (tester) async {
    await _pump(tester);

    Opacity opacity() => tester.widget<Opacity>(
      find
          .descendant(
            of: find.byKey(kSuspendedScreenFadeKey),
            matching: find.byType(Opacity),
          )
          .first,
    );

    expect(opacity().opacity, lessThan(1));
    await tester.pump(const Duration(milliseconds: 100));
    expect(opacity().opacity, inExclusiveRange(0, 1));
    await tester.pump(const Duration(milliseconds: 100));
    expect(opacity().opacity, 1);
  });
}
