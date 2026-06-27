import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbJobCard', () {
    const BbJobCardData data = BbJobCardData(
      title: 'CNC Operator',
      company: 'Sharma Works',
      payBand: '22-28k',
      place: 'Pimpri',
      shift: 'Day',
      tags: <String>['Fanuc'],
      spotsLeft: 4,
    );

    testWidgets('renders title, company, pay, tag and the spots line',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.text('Sharma Works'), findsOneWidget);
      expect(find.text('22-28k'), findsOneWidget);
      expect(find.text('Fanuc'), findsOneWidget);
      expect(find.textContaining('spots'), findsOneWidget);
    });

    testWidgets('shows the verified seal when verified is true', (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));
      expect(find.byIcon(Icons.verified), findsOneWidget);
    });

    testWidgets('fires onTitleTap when the title is tapped', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () => taps++),
      ));

      await tester.tap(find.text('CNC Operator'));
      expect(taps, 1);
    });

    testWidgets('omits the quota line when spotsLeft is null', (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'Welder',
          company: 'Patel Fab',
          payBand: '18-24k',
          place: 'Bhosari',
          shift: 'Night',
        ),
      )));

      expect(find.textContaining('spots'), findsNothing);
    });
  });
}
