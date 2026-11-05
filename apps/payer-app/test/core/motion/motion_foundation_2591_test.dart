import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/theme/app_haptics.dart';
import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/theme/app_page_transitions.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_card.dart';
import 'package:payer_app/core/widgets/bb_chip.dart';
import 'package:payer_app/core/widgets/bb_overlay_host.dart';
import 'package:payer_app/core/widgets/bb_pressable.dart';
import 'package:payer_app/core/widgets/bb_stat.dart';

/// #2591 (M3) — the payer-app motion foundation. One test group per primitive:
/// tokens + reduced-motion gate, haptics, BbPressable (scale, haptic, navy
/// edge), the ripple fix, page transitions + predictive back, the in-shell
/// overlay host, the root switcher and the sliding tab indicator. Every
/// animated primitive is also checked to drop to ZERO duration when the OS
/// "remove animations" setting is on.
void main() {
  late List<String> haptics;

  setUp(() {
    haptics = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      if (call.method == 'HapticFeedback.vibrate') {
        haptics.add(call.arguments as String);
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  /// Wraps [child] in the app theme; [reduced] mirrors the OS "remove
  /// animations" accessibility switch.
  Widget host(Widget child, {bool reduced = false}) => MaterialApp(
        theme: AppTheme.light(),
        // Above the Navigator, so pushed routes see the setting too.
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: BbRouteMotionScope(child: app!),
        ),
        home: Scaffold(body: Center(child: child)),
      );

  const String light = 'HapticFeedbackType.lightImpact';
  const String medium = 'HapticFeedbackType.mediumImpact';

  group('AppMotion tokens', () {
    test(
        'match the issue: press 90 · page 300 · sheet 280 · tab 220 · '
        'stagger 30, scale 0.97, slide 8%', () {
      expect(AppMotion.press, const Duration(milliseconds: 90));
      expect(AppMotion.page, const Duration(milliseconds: 300));
      expect(AppMotion.sheet, const Duration(milliseconds: 280));
      expect(AppMotion.tab, const Duration(milliseconds: 220));
      expect(AppMotion.stagger, const Duration(milliseconds: 30));
      expect(AppMotion.pressScale, 0.97);
      expect(AppMotion.pageSlide, 0.08);
      // Emphasized enter: front-loaded (well past half-way at t = 0.3).
      expect(AppMotion.emphasized.transform(0.3), greaterThan(0.5));
    });

    testWidgets(
        'resolve() keeps a duration, and zeroes it with animations '
        'disabled', (WidgetTester tester) async {
      late Duration normal;
      late Duration reduced;
      late AnimationStyle sheet;
      await tester.pumpWidget(host(Builder(builder: (BuildContext c) {
        normal = AppMotion.resolve(c, AppMotion.page);
        return const SizedBox();
      })));
      await tester.pumpWidget(host(
        Builder(builder: (BuildContext c) {
          reduced = AppMotion.resolve(c, AppMotion.page);
          sheet = AppMotion.sheetStyle(c);
          return const SizedBox();
        }),
        reduced: true,
      ));
      expect(normal, AppMotion.page);
      expect(reduced, Duration.zero);
      expect(sheet.duration, Duration.zero);
      expect(sheet.reverseDuration, Duration.zero);
    });
  });

  group('AppHaptics', () {
    testWidgets('tap = light, confirm = medium, error = double light tick',
        (WidgetTester tester) async {
      await AppHaptics.tap();
      expect(haptics, <String>[light]);

      haptics.clear();
      await AppHaptics.confirm();
      expect(haptics, <String>[medium]);

      haptics.clear();
      await tester.runAsync(AppHaptics.error);
      expect(haptics, <String>[light, light]);
    });
  });

  group('BbPressable', () {
    AnimatedScale scaleOf(WidgetTester tester) => tester.widget<AnimatedScale>(
          find.descendant(
            of: find.byType(BbPressable),
            matching: find.byType(AnimatedScale),
          ),
        );

    testWidgets(
        'presses to 0.97 over 90ms, springs back, fires a light '
        'haptic and the tap', (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(host(BbPressable(
        onTap: () => taps++,
        child: const SizedBox(width: 120, height: 48, child: Text('Press')),
      )));
      expect(scaleOf(tester).scale, 1);
      expect(scaleOf(tester).duration, AppMotion.press);

      final TestGesture g =
          await tester.startGesture(tester.getCenter(find.text('Press')));
      await tester.pump(const Duration(milliseconds: 200));
      expect(scaleOf(tester).scale, AppMotion.pressScale);

      await g.up();
      await tester.pumpAndSettle();
      expect(scaleOf(tester).scale, 1);
      expect(taps, 1);
      expect(haptics, <String>[light]);
    });

    testWidgets('press duration is zero with animations disabled',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(
        BbPressable(onTap: () {}, child: const Text('Press')),
        reduced: true,
      ));
      expect(scaleOf(tester).duration, Duration.zero);
    });

    testWidgets('the navy edge collapses on press',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(BbPressable(
        onTap: () {},
        edge: true,
        child: const SizedBox(width: 120, height: 48, child: Text('Edge')),
      )));
      expect(find.byKey(BbPressable.edgeKey), findsOneWidget);
      final double restTop = tester.getTopLeft(find.text('Edge')).dy;

      final TestGesture g =
          await tester.startGesture(tester.getCenter(find.text('Edge')));
      await tester.pumpAndSettle();
      // Pressed: the surface sinks onto its edge (scale also pulls it in, so
      // the text drops by at least the edge depth minus the scale inset).
      expect(tester.getTopLeft(find.text('Edge')).dy, greaterThan(restTop));

      await g.up();
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(find.text('Edge')).dy, restTop);
    });

    testWidgets('passive mode animates without stealing the child tap',
        (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(host(BbPressable.passive(
        child: TextButton(onPressed: () => taps++, child: const Text('Go')),
      )));
      final TestGesture g =
          await tester.startGesture(tester.getCenter(find.text('Go')));
      await tester.pump(const Duration(milliseconds: 200));
      expect(scaleOf(tester).scale, AppMotion.pressScale);
      await g.up();
      await tester.pumpAndSettle();
      expect(taps, 1);
      // The child owns its haptic; passive mode adds none.
      expect(haptics, isEmpty);
    });

    testWidgets('a disabled surface never presses',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(const BbPressable(
        onTap: null,
        child: SizedBox(width: 120, height: 48, child: Text('Off')),
      )));
      final TestGesture g =
          await tester.startGesture(tester.getCenter(find.text('Off')));
      await tester.pump(const Duration(milliseconds: 200));
      expect(scaleOf(tester).scale, 1);
      await g.up();
      expect(haptics, isEmpty);
    });

    testWidgets('BbButton presses; only the primary CTA carries the edge',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          BbButton(label: 'Primary', onPressed: () {}),
          BbButton(
            label: 'Secondary',
            variant: BbButtonVariant.secondary,
            onPressed: () {},
          ),
        ],
      )));
      expect(find.byType(BbPressable), findsNWidgets(2));
      expect(find.byKey(BbPressable.edgeKey), findsOneWidget);
      expect(
        find.descendant(
          of: find.ancestor(
            of: find.text('Primary'),
            matching: find.byType(BbPressable),
          ),
          matching: find.byKey(BbPressable.edgeKey),
        ),
        findsOneWidget,
      );

      await tester.tap(find.text('Secondary'));
      await tester.pumpAndSettle();
      expect(haptics, <String>[light]); // exactly one haptic per press
    });
  });

  group('Ripple fix — surfaces paint with Ink, so the splash shows on them',
      () {
    testWidgets('a tappable BbCard paints its surface with Ink',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(BbCard(
        onTap: () {},
        child: const Text('Card'),
      )));
      expect(
        find.descendant(of: find.byType(BbCard), matching: find.byType(Ink)),
        findsOneWidget,
      );
      expect(
        find.descendant(
            of: find.byType(BbCard), matching: find.byType(BbPressable)),
        findsOneWidget,
      );
    });

    testWidgets('a featured tappable BbCard also paints with Ink',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(BbCard(
        featured: true,
        onTap: () {},
        child: const Text('Hot'),
      )));
      expect(
        find.descendant(of: find.byType(BbCard), matching: find.byType(Ink)),
        findsOneWidget,
      );
    });

    testWidgets('a static BbCard stays a plain surface (no ink, no press)',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(const BbCard(child: Text('Static'))));
      expect(
        find.descendant(of: find.byType(BbCard), matching: find.byType(Ink)),
        findsNothing,
      );
      expect(
        find.descendant(
            of: find.byType(BbCard), matching: find.byType(BbPressable)),
        findsNothing,
      );
    });

    testWidgets('BbChip paints its pill with Ink and presses',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(BbChip(label: 'Welder', onTap: () {})));
      expect(
        find.descendant(of: find.byType(BbChip), matching: find.byType(Ink)),
        findsOneWidget,
      );
      await tester.tap(find.text('Welder'));
      await tester.pumpAndSettle();
      expect(haptics, <String>[light]);
    });

    testWidgets('the BbStat link gets its own Material above the tile fill',
        (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(host(SizedBox(
        width: 200,
        child: BbStat(
          label: 'Credits',
          value: '12',
          icon: Icons.lock_open_rounded,
          deltaText: 'Buy credits',
          onDeltaTap: () => taps++,
        ),
      )));
      final Finder link = find.descendant(
        of: find.byType(BbStat),
        matching: find.byType(BbPressable),
      );
      expect(link, findsOneWidget);
      // The InkWell's nearest Material is INSIDE the stat tile, i.e. painted
      // above the tile's white decoration — not the Scaffold's, under it.
      expect(
        find.descendant(of: link, matching: find.byType(Material)),
        findsOneWidget,
      );
      await tester.tap(find.text('Buy credits'));
      await tester.pumpAndSettle();
      expect(taps, 1);
    });
  });

  group('Page transitions', () {
    testWidgets('the theme routes every platform through the fade + slide',
        (WidgetTester tester) async {
      final PageTransitionsTheme theme = AppTheme.light().pageTransitionsTheme;
      for (final TargetPlatform p in TargetPlatform.values) {
        expect(theme.builders[p], isA<BbPageTransitionsBuilder>(),
            reason: '$p');
      }
      expect(
          const BbPageTransitionsBuilder().transitionDuration, AppMotion.page);
    });

    Future<void> pushPage(WidgetTester tester, {bool reduced = false}) async {
      await tester.pumpWidget(host(
        Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => const Scaffold(body: Text('Next page')),
              ),
            ),
            child: const Text('open'),
          ),
        ),
        reduced: reduced,
      ));
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
    }

    testWidgets('a pushed route fades + slides in over 300ms',
        (WidgetTester tester) async {
      await pushPage(tester);
      final Finder fade = find.descendant(
        of: find.byType(BbFadeSlideTransition),
        matching: find.byType(FadeTransition),
      );
      expect(fade, findsWidgets);
      // .last = the route being pushed (the home route is settled at 1).
      final double opacity =
          tester.widget<FadeTransition>(fade.last).opacity.value;
      expect(opacity, greaterThan(0));
      expect(opacity, lessThan(1));
      final Offset slide = tester
          .widget<SlideTransition>(find
              .descendant(
                of: find.byType(BbFadeSlideTransition),
                matching: find.byType(SlideTransition),
              )
              .last)
          .position
          .value;
      expect(slide.dx, greaterThan(0));
      expect(slide.dx, lessThanOrEqualTo(AppMotion.pageSlide));
      await tester.pumpAndSettle();
      expect(find.text('Next page'), findsOneWidget);
    });

    testWidgets('with animations disabled the route has no transition',
        (WidgetTester tester) async {
      await pushPage(tester, reduced: true);
      expect(
        find.descendant(
          of: find.byType(BbFadeSlideTransition),
          matching: find.byType(FadeTransition),
        ),
        findsNothing,
      );
      await tester.pumpAndSettle();
    });

    testWidgets('with animations disabled push + pop take zero time',
        (WidgetTester tester) async {
      await pushPage(tester, reduced: true);
      final ModalRoute<dynamic> route =
          ModalRoute.of(tester.element(find.text('Next page')))!;
      expect(route.transitionDuration, Duration.zero);
      expect(route.reverseTransitionDuration, Duration.zero);
      Navigator.of(tester.element(find.text('Next page'))).pop();
      await tester.pump();
      expect(find.text('Next page'), findsNothing);
      expect(find.text('open'), findsOneWidget);
    });

    testWidgets('Android predictive back drives the route with the swipe',
        (WidgetTester tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        await pushPage(tester);
        await tester.pumpAndSettle();
        final ModalRoute<dynamic> route =
            ModalRoute.of(tester.element(find.text('Next page')))!;
        expect(route.animation!.value, 1);

        Future<void> send(String method, [Object? args]) async {
          await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
            'flutter/backgesture',
            const StandardMethodCodec()
                .encodeMethodCall(MethodCall(method, args)),
            (ByteData? _) {},
          );
          await tester.pump();
        }

        Map<String, Object?> event(double progress) => <String, Object?>{
              'touchOffset': <double>[5, 300],
              'progress': progress,
              'swipeEdge': 0,
            };

        await send('startBackGesture', event(0));
        await send('updateBackGestureProgress', event(0.5));
        expect(route.animation!.value, closeTo(0.5, 0.01));

        await send('commitBackGesture');
        await tester.pumpAndSettle();
        expect(find.text('Next page'), findsNothing);
        expect(find.text('open'), findsOneWidget);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });

  group('BbOverlayHost', () {
    Widget overlayHost({required bool open, bool reduced = false}) => host(
          SizedBox(
            width: 300,
            height: 400,
            child: BbOverlayHost(
              base: const Text('Base tab'),
              overlay: open ? const Text('Overlay') : null,
            ),
          ),
          reduced: reduced,
        );

    double overlayOpacity(WidgetTester tester) => tester
        .widget<FadeTransition>(find
            .ancestor(
                of: find.text('Overlay'), matching: find.byType(FadeTransition))
            .first)
        .opacity
        .value;

    testWidgets('animates the overlay in and out over the base',
        (WidgetTester tester) async {
      await tester.pumpWidget(overlayHost(open: false));
      await tester.pumpWidget(overlayHost(open: true));
      await tester.pump(const Duration(milliseconds: 100));
      // Mid-enter: both on stage, overlay partly faded in.
      expect(find.text('Base tab'), findsOneWidget);
      expect(find.text('Overlay'), findsOneWidget);
      expect(overlayOpacity(tester), inExclusiveRange(0, 1));

      await tester.pumpAndSettle();
      // Covered: base kept mounted but offstage.
      expect(find.text('Base tab'), findsNothing);
      expect(find.text('Base tab', skipOffstage: false), findsOneWidget);

      await tester.pumpWidget(overlayHost(open: false));
      await tester.pump(const Duration(milliseconds: 100));
      // Mid-exit: still painted, fading, and already ignoring input.
      expect(find.text('Overlay'), findsOneWidget);
      expect(find.text('Base tab'), findsOneWidget);
      expect(overlayOpacity(tester), inExclusiveRange(0, 1));
      expect(
        tester
            .widget<IgnorePointer>(find
                .ancestor(
                    of: find.text('Overlay'),
                    matching: find.byType(IgnorePointer))
                .first)
            .ignoring,
        isTrue,
      );

      await tester.pumpAndSettle();
      expect(find.text('Overlay', skipOffstage: false), findsNothing);
    });

    testWidgets('swaps instantly with animations disabled',
        (WidgetTester tester) async {
      await tester.pumpWidget(overlayHost(open: false, reduced: true));
      await tester.pumpWidget(overlayHost(open: true, reduced: true));
      expect(find.text('Overlay'), findsOneWidget);
      expect(find.text('Base tab'), findsNothing);
      expect(
        find.ancestor(
            of: find.text('Overlay'), matching: find.byType(FadeTransition)),
        findsNothing,
      );

      await tester.pumpWidget(overlayHost(open: false, reduced: true));
      expect(find.text('Overlay', skipOffstage: false), findsNothing);
      expect(find.text('Base tab'), findsOneWidget);
    });
  });

  group('BbFadeSlideSwitcher (splash → login → app)', () {
    Duration switcherDuration(WidgetTester tester) =>
        tester.widget<AnimatedSwitcher>(find.byType(AnimatedSwitcher)).duration;

    testWidgets('cross-fades + slides keyed screens over 300ms',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(const BbFadeSlideSwitcher(
        child: Text('Splash', key: ValueKey<String>('a')),
      )));
      expect(switcherDuration(tester), AppMotion.page);
      await tester.pumpWidget(host(const BbFadeSlideSwitcher(
        child: Text('Login', key: ValueKey<String>('b')),
      )));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Splash'), findsOneWidget);
      expect(find.text('Login'), findsOneWidget);
      await tester.pumpAndSettle();
      expect(find.text('Splash'), findsNothing);
    });

    testWidgets('is instant with animations disabled',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(
        const BbFadeSlideSwitcher(child: Text('Splash')),
        reduced: true,
      ));
      expect(switcherDuration(tester), Duration.zero);
    });
  });

  group('BbBottomNav tab indicator', () {
    const List<BbNavTab> tabs = <BbNavTab>[
      BbNavTab(
          id: 'a',
          label: 'A',
          iconInactive: Icons.home_rounded,
          iconActive: Icons.home_rounded),
      BbNavTab(
          id: 'b',
          label: 'B',
          iconInactive: Icons.search_rounded,
          iconActive: Icons.search_rounded),
      BbNavTab(
          id: 'c',
          label: 'C',
          iconInactive: Icons.work_rounded,
          iconActive: Icons.work_rounded),
    ];

    Widget nav(String current, {bool reduced = false}) => MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(disableAnimations: reduced),
            child: Scaffold(
              bottomNavigationBar: BbBottomNav(
                tabs: tabs,
                currentId: current,
                onSelect: (_) {},
              ),
            ),
          ),
        );

    AnimatedSlide indicator(WidgetTester tester) =>
        tester.widget<AnimatedSlide>(find.byKey(BbBottomNav.indicatorKey));

    testWidgets('slides to the active slot over 220ms',
        (WidgetTester tester) async {
      await tester.pumpWidget(nav('a'));
      expect(indicator(tester).offset, Offset.zero);
      expect(indicator(tester).duration, AppMotion.tab);

      await tester.pumpWidget(nav('c'));
      expect(indicator(tester).offset, const Offset(2, 0));
      await tester.pump(const Duration(milliseconds: 100));
      expect(tester.hasRunningAnimations, isTrue);
      await tester.pumpAndSettle();
    });

    testWidgets('tapping a tab fires a light haptic',
        (WidgetTester tester) async {
      await tester.pumpWidget(nav('a'));
      await tester.tap(find.text('B'));
      await tester.pumpAndSettle();
      expect(haptics, <String>[light]);
    });

    testWidgets('indicator duration is zero with animations disabled',
        (WidgetTester tester) async {
      await tester.pumpWidget(nav('b', reduced: true));
      expect(indicator(tester).duration, Duration.zero);
      expect(indicator(tester).offset, const Offset(1, 0));
    });
  });
}
