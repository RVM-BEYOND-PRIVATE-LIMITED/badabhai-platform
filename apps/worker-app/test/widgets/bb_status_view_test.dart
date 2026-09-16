import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_status_view.dart';

import '../support/kit_matrix.dart';

Widget _host(Widget child) => MaterialApp(
  theme: AppTheme.light(),
  home: Scaffold(body: Center(child: child)),
);

void main() {
  group('BbStatusView', () {
    testWidgets('renders icon, title, subtitle and action', (tester) async {
      await tester.pumpWidget(
        _host(
          const BbStatusView(
            icon: Icons.cloud_off_rounded,
            title: 'Oops',
            subtitle: 'try',
            action: Text('A'),
          ),
        ),
      );

      expect(find.byIcon(Icons.cloud_off_rounded), findsOneWidget);
      expect(find.text('Oops'), findsOneWidget);
      expect(find.text('try'), findsOneWidget);
      expect(find.text('A'), findsOneWidget);
    });

    testWidgets('loading mode shows a spinner and its caption', (tester) async {
      await tester.pumpWidget(
        _host(const BbStatusView.loading(caption: 'Loading')),
      );

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Loading'), findsOneWidget);
    });

    // THE host that broke this widget, and the reason this test exists.
    // `SliverFillRemaining(hasScrollBody: false)` asks its child for an
    // INTRINSIC height — the job search screen wraps every idle / empty / error
    // state in exactly that — and a `LayoutBuilder` cannot answer the question
    // ('LayoutBuilder does not support returning intrinsic dimensions'). The
    // screen was replaced by an error box, so every finder under it found
    // nothing and five unrelated tests failed on a null-check inside the
    // viewport. Anything added to this widget must stay intrinsic-safe.
    testWidgets('survives a host that asks for its INTRINSIC height', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: CustomScrollView(
              slivers: const <Widget>[
                SliverAppBar(title: Text('Search')),
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: BbStatusView(
                    icon: Icons.search_rounded,
                    title: 'Jobs dhoondein',
                    subtitle: 'Job title aur city daalein.',
                  ),
                ),
              ],
            ),
          ),
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('Jobs dhoondein'), findsOneWidget);
    });

    testWidgets('scrolls rather than overflowing at 320x568 @2.0', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: BbStatusView(
              icon: Icons.cloud_off_rounded,
              title: 'Jobs load nahi hue. Dobara koshish karein',
              subtitle:
                  'Agar phir bhi nahi chale, thodi der baad dekhein. '
                  'Aapka data safe hai.',
              action: Text('Dobara koshish karein'),
            ),
          ),
          textScale: 2.0,
        ),
      );

      expect(tester.takeException(), isNull);
      // The action is reachable: below the fold at this size, so by SCROLL.
      await tester.scrollUntilVisible(
        find.text('Dobara koshish karein'),
        80,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Dobara koshish karein'), findsOneWidget);
    });
  });
}
