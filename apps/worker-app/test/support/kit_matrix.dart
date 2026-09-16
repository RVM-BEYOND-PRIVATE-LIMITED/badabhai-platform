import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';

/// The device sizes every redesigned screen must survive.
///
/// The kit is drawn on one 390x844 artboard; these are the shapes a worker
/// actually owns. 320x568 is the floor (a budget Android / iPhone SE 1),
/// 768x1024 is a tablet, and 844x390 is a phone in landscape — the two that
/// break a layout built only for the artboard.
const List<Size> kKitMatrixSizes = <Size>[
  Size(320, 568),
  Size(360, 640),
  Size(390, 844),
  Size(412, 915),
  Size(768, 1024),
  Size(844, 390),
];

/// System font scales every redesigned screen must survive.
///
/// 2.0 is the real ceiling the app now honours: chrome clamps itself at 1.3,
/// but body copy scales the whole way and must scroll rather than overflow.
const List<double> kKitMatrixTextScales = <double>[1.0, 1.5, 2.0];

/// Points the test view at [size], optionally with a [keyboard] up, and resets
/// it afterwards.
///
/// `devicePixelRatio` is pinned to 1 so `physicalSize` reads as logical pixels
/// and the sizes above mean what they say.
///
/// [keyboard] is set on the VIEW, not on a `MediaQuery` wrapper, because that is
/// where a real keyboard lives. A [Scaffold] strips `viewInsets.bottom` from its
/// body, so a widget inside one cannot see a MediaQuery-only keyboard — faking
/// it at the MediaQuery level tests a state that never occurs on a device.
void setKitSurface(WidgetTester tester, Size size, {double keyboard = 0}) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  if (keyboard > 0) {
    tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
    addTearDown(tester.view.resetViewInsets);
  }
}

/// Wraps [child] in the real app theme at a given [textScale].
///
/// A keyboard belongs to the VIEW, so pass it to [setKitSurface] instead.
Widget kitTestApp(Widget child, {double textScale = 1.0}) {
  return MaterialApp(
    theme: AppTheme.light(),
    builder: (BuildContext context, Widget? built) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: TextScaler.linear(textScale)),
      child: built ?? const SizedBox.shrink(),
    ),
    home: child,
  );
}

/// Runs [build] across [kKitMatrixSizes] x [kKitMatrixTextScales] and asserts
/// that nothing threw and that [primary] is still reachable.
///
/// PASS means two things, both of which have actually regressed before:
///  1. no exception — a `RenderFlex` overflow surfaces through `takeException`;
///  2. the primary action is IN THE TREE, and scrolled to if the screen scrolls.
///     A CTA that exists but sits forever below the fold is not a pass.
///
/// It never calls `pumpAndSettle`: several of these screens carry an indefinite
/// animation (a spinner, a live pulse), which would pump until the test timed
/// out. Fixed `pump(Duration)` steps instead.
void kitMatrixTest(
  String description,
  Widget Function() build, {
  required Finder Function() primary,
  Future<void> Function(WidgetTester tester)? arrange,
  double keyboard = 0,
}) {
  for (final Size size in kKitMatrixSizes) {
    for (final double scale in kKitMatrixTextScales) {
      testWidgets(
        '$description — ${size.width.toInt()}x${size.height.toInt()} @ ${scale}x',
        (WidgetTester tester) async {
          setKitSurface(tester, size, keyboard: keyboard);
          await tester.pumpWidget(kitTestApp(build(), textScale: scale));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          if (arrange != null) await arrange(tester);

          expect(
            tester.takeException(),
            isNull,
            reason: '$description threw at $size, text x$scale',
          );

          final Finder target = primary();
          if (target.evaluate().isEmpty) {
            final Finder scrollable = find.byType(Scrollable);
            if (scrollable.evaluate().isNotEmpty) {
              await tester.scrollUntilVisible(
                target,
                120,
                scrollable: scrollable.first,
              );
            }
          }
          expect(
            target,
            findsWidgets,
            reason: 'primary action unreachable at $size, text x$scale',
          );

          // Unmount so no timer or animation outlives the test.
          await tester.pumpWidget(const SizedBox.shrink());
        },
      );
    }
  }
}

/// Asserts every tappable thing on screen clears Android's 48dp target.
///
/// Run at 360x640 @1.0 — a real, common handset, where a failure means a real
/// thumb, not a synthetic edge case.
Future<void> expectKitTapTargets(WidgetTester tester) async {
  await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
}

/// The rendered width of [finder] — for the tablet assertion, where the content
/// column must stop rather than stretch.
double widthOf(WidgetTester tester, Finder finder) =>
    tester.getSize(finder).width;

/// Loads the app's REAL bundled faces into the test binding, so a test can
/// assert what a worker actually sees.
///
/// Call it from `setUpAll` in the (few) tests whose subject is text METRICS —
/// truncation, clipping, whether a label fits. Everything else should stay on
/// the default test font, which is deterministic and fast.
///
/// WHY IT IS NEEDED. Under `flutter test` every glyph of the fallback font is a
/// full em square, so a string measures far wider than in Anek or Inter. That
/// cuts both ways and both ways are wrong: an assertion written against the
/// test font fails on copy that fits perfectly on a device, and a truncation a
/// worker really sees (the tab header ellipsising 'Kaam milega.' to 'Kaa…') is
/// invisible to the suite, because the `Text` widget holds the whole string
/// whether or not the paragraph painted it.
Future<void> loadKitFonts() async {
  const Map<String, List<String>> families = <String, List<String>>{
    'Anek Latin': <String>[
      'assets/fonts/AnekLatin-SemiBold.ttf',
      'assets/fonts/AnekLatin-Bold.ttf',
      'assets/fonts/AnekLatin-ExtraBold.ttf',
    ],
    'Inter': <String>[
      'assets/fonts/Inter-Regular.ttf',
      'assets/fonts/Inter-Medium.ttf',
      'assets/fonts/Inter-SemiBold.ttf',
      'assets/fonts/Inter-Bold.ttf',
    ],
    'Roboto Mono': <String>[
      'assets/fonts/RobotoMono-Regular.ttf',
      'assets/fonts/RobotoMono-Bold.ttf',
    ],
  };
  for (final MapEntry<String, List<String>> family in families.entries) {
    final FontLoader loader = FontLoader(family.key);
    for (final String path in family.value) {
      loader.addFont(
        File(path).readAsBytes().then((Uint8List b) => b.buffer.asByteData()),
      );
    }
    await loader.load();
  }
}
