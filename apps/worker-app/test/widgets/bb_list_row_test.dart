import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_list_row.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbListRow', () {
    testWidgets('renders the whole family and fires the setting tap',
        (tester) async {
      int settingTaps = 0;
      int kitTaps = 0;

      await tester.pumpWidget(_host(
        Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            BbListRow.setting(
              icon: Icons.translate,
              title: 'Bhasha',
              subtitle: 'Hindi',
              onTap: () => settingTaps++,
            ),
            BbListRow.notification(
              icon: Icons.work,
              tone: BbNotiTone.green,
              title: 'Naya job',
              subtitle: 'X',
              time: 'Abhi',
            ),
            BbListRow.status(
              icon: Icons.send,
              green: true,
              label: 'Applied',
              state: 'Now',
            ),
            BbListRow.kit(
              icon: Icons.quiz_outlined,
              title: 'Interview kit',
              subtitle: '15 Q',
              onTap: () => kitTaps++,
            ),
          ],
        ),
      ));

      expect(find.text('Bhasha'), findsOneWidget);
      expect(find.text('Naya job'), findsOneWidget);
      expect(find.text('Applied'), findsOneWidget);
      expect(find.text('Interview kit'), findsOneWidget);

      await tester.tap(find.text('Bhasha'));
      expect(settingTaps, 1);
    });

    testWidgets('notification tone maps to a coloured tile', (tester) async {
      await tester.pumpWidget(_host(
        BbListRow.notification(
          icon: Icons.bolt,
          tone: BbNotiTone.brand,
          title: 'Boost',
          subtitle: 'Active',
          time: '2h',
        ),
      ));
      expect(find.text('Boost'), findsOneWidget);
      expect(find.byIcon(Icons.bolt), findsOneWidget);
    });

    testWidgets('setting row supports a danger variant', (tester) async {
      await tester.pumpWidget(_host(
        BbListRow.setting(
          icon: Icons.delete_outline,
          title: 'Delete account',
          danger: true,
          onTap: () {},
        ),
      ));
      expect(find.text('Delete account'), findsOneWidget);
      expect(find.byIcon(Icons.chevron_right), findsOneWidget);
    });
  });
}
