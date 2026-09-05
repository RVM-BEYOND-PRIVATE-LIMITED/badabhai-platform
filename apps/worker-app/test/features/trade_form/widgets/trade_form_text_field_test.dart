import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/devanagari_guard.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_text_field.dart';

/// `TradeFormTextField` is the ONE widget every trade-form free-text field
/// routes through (employer/role/work text, certificate name/issuer,
/// education field/institute, the generic open-answer question box) — so
/// its Devanagari guard (#1411) is tested once here rather than at each of
/// the ~15 call sites.
void main() {
  Future<void> pump(WidgetTester tester, TextEditingController controller,
      {String? errorText}) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TradeFormTextField(
          controller: controller,
          hint: 'Jaise: CNC Turning',
          errorText: errorText,
        ),
      ),
    ));
  }

  testWidgets('typing Devanagari strips it and shows the hint',
      (WidgetTester tester) async {
    final TextEditingController controller = TextEditingController();
    addTearDown(controller.dispose);
    await pump(tester, controller);

    await tester.enterText(find.byType(TextField), 'मेने काम किया');
    await tester.pump();

    expect(controller.text, isNot(contains(RegExp('[ऀ-ॿ]'))));
    expect(find.text(kDevanagariBlockedHint), findsOneWidget);
  });

  testWidgets('plain Roman/Hinglish typing never shows the hint',
      (WidgetTester tester) async {
    final TextEditingController controller = TextEditingController();
    addTearDown(controller.dispose);
    await pump(tester, controller);

    await tester.enterText(find.byType(TextField), 'CNC Turning & Fanuc');
    await tester.pump();

    expect(controller.text, 'CNC Turning & Fanuc');
    expect(find.text(kDevanagariBlockedHint), findsNothing);
  });

  testWidgets(
      "a caller's own errorText takes priority over the Devanagari hint",
      (WidgetTester tester) async {
    final TextEditingController controller = TextEditingController();
    addTearDown(controller.dispose);
    await pump(tester, controller, errorText: 'Sahi saal likhein');

    await tester.enterText(find.byType(TextField), 'मेने');
    await tester.pump();

    // Devanagari was still stripped from the text...
    expect(controller.text, isNot(contains(RegExp('[ऀ-ॿ]'))));
    // ...but the caller's own validation message is what's shown, since it
    // is more specific to what the worker is doing right now.
    expect(find.text('Sahi saal likhein'), findsOneWidget);
    expect(find.text(kDevanagariBlockedHint), findsNothing);
  });

  testWidgets('the Devanagari hint stays up across further Roman typing',
      (WidgetTester tester) async {
    final TextEditingController controller = TextEditingController();
    addTearDown(controller.dispose);
    await pump(tester, controller);

    await tester.enterText(find.byType(TextField), 'क');
    await tester.pump();
    expect(find.text(kDevanagariBlockedHint), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'CNC');
    await tester.pump();
    expect(find.text(kDevanagariBlockedHint), findsOneWidget,
        reason: 'the hint is sticky guidance, not a per-keystroke scold');
  });
}
