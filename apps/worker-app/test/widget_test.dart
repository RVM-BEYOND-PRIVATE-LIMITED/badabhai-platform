import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:badabhai_worker_app/app.dart';

void main() {
  // The splash is the brand artwork (logo, wordmark, tagline) with the Flutter
  // "Get started" button on top.
  testWidgets('Splash shows brand and get-started CTA', (WidgetTester tester) async {
    await tester.pumpWidget(const BadaBhaiApp());
    expect(find.byKey(const Key('splash_image')), findsOneWidget);
    expect(find.text('Get started'), findsOneWidget);
  });
}
