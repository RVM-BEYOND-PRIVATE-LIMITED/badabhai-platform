import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/applied_screen.dart';

void main() {
  testWidgets('renders the confirmation hero, company and status timeline', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(
      home: AppliedScreen(
        job: BbJobCardData(
          title: 'CNC Operator',
          company: 'Sharma Works',
          payBand: '22-28k',
          place: 'Pimpri, Pune',
          shift: 'Day',
        ),
      ),
    ));
    await tester.pumpAndSettle(); // success-stamp pop

    expect(find.text('Apply ho gaya!'), findsOneWidget);
    expect(find.textContaining('Sharma Works'), findsOneWidget);
    expect(find.text('Applied'), findsOneWidget);
    expect(find.text('Employer ne dekha'), findsOneWidget);
    expect(find.text('Aur jobs dekhein'), findsOneWidget);
  });

  testWidgets('falls back gracefully when no job is passed', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: AppliedScreen()));
    await tester.pumpAndSettle();

    expect(find.text('Apply ho gaya!'), findsOneWidget);
    expect(find.textContaining('The employer'), findsOneWidget);
  });
}
