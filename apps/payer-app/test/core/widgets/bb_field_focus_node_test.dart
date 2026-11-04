import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/widgets/bb_field.dart';
import 'package:payer_app/core/widgets/bb_focus_chain.dart';

/// BbField's plain `focusNode` (for a caller that manages focus itself, e.g.
/// the M9 set-new-password step) and its precedence under a [BbFieldFlow].
void main() {
  TextField field(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField));

  testWidgets('a plain focusNode reaches the TextField', (
    WidgetTester tester,
  ) async {
    final FocusNode node = FocusNode();
    addTearDown(node.dispose);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: BbField(
          label: 'Password',
          controller: TextEditingController(),
          focusNode: node,
        ),
      ),
    ));

    expect(field(tester).focusNode, same(node));
    node.requestFocus();
    await tester.pump();
    expect(node.hasFocus, isTrue);
  });

  testWidgets("a flow's node wins over a plain focusNode", (
    WidgetTester tester,
  ) async {
    final FocusNode plain = FocusNode();
    final FocusNode chained = FocusNode();
    addTearDown(plain.dispose);
    addTearDown(chained.dispose);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: BbField(
          label: 'Pay',
          controller: TextEditingController(),
          focusNode: plain,
          flow: BbFieldFlow(
            focusNode: chained,
            action: TextInputAction.next,
            onAction: () {},
          ),
        ),
      ),
    ));

    expect(field(tester).focusNode, same(chained));
  });
}
