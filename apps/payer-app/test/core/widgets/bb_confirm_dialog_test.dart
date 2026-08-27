import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/widgets/bb_alert_dialog.dart';

/// The Sign-out confirm (and any other two-button consequential prompt) rides on
/// [showBbConfirm]. Contract under test: confirm → true, cancel → false, and a
/// barrier tap → false (tap-outside is the SAFE default for a destructive
/// prompt, so a mis-tap can never end the session).
void main() {
  Future<void> open(WidgetTester tester) async {
    _last = null;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => Center(
              child: ElevatedButton(
                onPressed: () async {
                  _last = await showBbConfirm(
                    context,
                    title: 'Sign out?',
                    message: 'You can sign back in with your OTP.',
                    confirmLabel: 'Sign out',
                    destructive: true,
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('renders title, message and both buttons', (WidgetTester tester) async {
    await open(tester);
    expect(find.text('Sign out?'), findsOneWidget);
    expect(find.text('You can sign back in with your OTP.'), findsOneWidget);
    expect(find.text('Sign out'), findsOneWidget); // confirm
    expect(find.text('Rehne do'), findsOneWidget); // default cancel
  });

  testWidgets('confirm returns true', (WidgetTester tester) async {
    await open(tester);
    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();
    expect(_last, isTrue);
  });

  testWidgets('cancel returns false', (WidgetTester tester) async {
    await open(tester);
    await tester.tap(find.text('Rehne do'));
    await tester.pumpAndSettle();
    expect(_last, isFalse);
  });

  testWidgets('barrier tap returns false', (WidgetTester tester) async {
    await open(tester);
    // Tap top-left, well outside the centred card, to dismiss via the barrier.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(_last, isFalse);
  });
}

/// The last result captured by [open]'s button — a module-level shim so each
/// test can assert the returned value without threading it back out.
bool? _last;
