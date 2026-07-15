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

    // `verified` now defaults to FALSE: the seal must be an explicit opt-in for
    // a REAL employer. It previously defaulted to true, so the card stamped a
    // green "verified" seal next to an employer name invented from
    // `jobId.hashCode`.
    testWidgets('shows the verified seal only when verified is explicitly true',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));
      expect(find.byIcon(Icons.verified), findsNothing);

      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'CNC Operator',
          company: 'Sharma Works',
          verified: true,
          place: 'Pimpri',
        ),
      )));
      expect(find.byIcon(Icons.verified), findsOneWidget);
    });

    // The real feed carries no employer/pay/shift/tags — the card must simply
    // omit them rather than render an invented value.
    testWidgets('omits employer, pay, shift and tags when the feed has none',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(title: 'CNC Operator', place: 'Pimpri, Pune'),
      )));

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.text('Pimpri, Pune'), findsOneWidget);
      expect(find.byIcon(Icons.currency_rupee), findsNothing);
      expect(find.byIcon(Icons.schedule), findsNothing);
      expect(find.byIcon(Icons.verified), findsNothing);
      expect(find.textContaining('spots'), findsNothing);
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
