import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/widgets/bb_field.dart';

/// A blank signup "Company name" field was being pre-populated by the keyboard
/// with an org name the user had typed in a DIFFERENT app (Gboard personalized
/// learning). Autofill is already off on these fields (no `autofillHints`);
/// `suppressSuggestions` closes the IME-learning path by turning off
/// autocorrect + the suggestion strip + personalized learning.
void main() {
  TextField findField(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField));

  Future<void> pump(WidgetTester tester, {required bool suppress}) =>
      tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: BbField(
            label: 'Company name',
            controller: TextEditingController(),
            suppressSuggestions: suppress,
          ),
        ),
      ));

  testWidgets('suppressSuggestions:true turns OFF autocorrect, suggestions, and '
      'IME personalized learning', (WidgetTester tester) async {
    await pump(tester, suppress: true);
    final TextField field = findField(tester);
    expect(field.autocorrect, isFalse);
    expect(field.enableSuggestions, isFalse);
    expect(field.enableIMEPersonalizedLearning, isFalse);
  });

  testWidgets('default (suppressSuggestions:false) leaves the IME behaviour '
      'untouched — ordinary fields keep suggestions', (WidgetTester tester) async {
    await pump(tester, suppress: false);
    final TextField field = findField(tester);
    expect(field.autocorrect, isTrue);
    expect(field.enableSuggestions, isTrue);
    expect(field.enableIMEPersonalizedLearning, isTrue);
  });
}
