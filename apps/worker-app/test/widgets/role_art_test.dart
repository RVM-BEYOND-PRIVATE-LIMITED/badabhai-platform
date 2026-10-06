import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/core/widgets/role_art/role_art.dart';

/// The role illustrations (`lib/core/widgets/role_art/`): every kind renders,
/// anything unknown falls back to the generic art, and the motion honours
/// reduce-motion / TickerMode. The generated data itself is checked against
/// `packages/role-art/art/*.svg` by that package's own test.
void main() {
  Widget host(Widget child, {bool disableAnimations = false}) => MediaQuery(
    data: MediaQueryData(
      size: const Size(360, 800),
      disableAnimations: disableAnimations,
    ),
    child: Directionality(
      textDirection: TextDirection.ltr,
      child: Center(child: SizedBox(width: 300, child: child)),
    ),
  );

  test('art exists for every declared role kind, in declared order', () {
    final List<String> order = File('../../packages/role-art/art/ORDER')
        .readAsLinesSync()
        .map((String l) => l.replaceAll(RegExp('#.*'), '').trim())
        .where((String l) => l.isNotEmpty)
        .toList();
    expect(kRoleArtKinds, order);
    expect(kRoleArtKinds.length, 22); // the 21 role kinds + generic
    expect(kRoleArtKinds.last, kRoleArtFallback);
  });

  group('resolveRoleArtKind — defensive', () {
    for (final Object? raw in <Object?>[
      null,
      '',
      'not_a_role',
      'WELDER',
      'toString',
      7,
      <String>['welder'],
    ]) {
      test('$raw → generic', () {
        expect(resolveRoleArtKind(raw), kRoleArtFallback);
      });
    }
    test('a declared kind → itself', () {
      expect(resolveRoleArtKind('welder'), 'welder');
    });
  });

  for (final String kind in kRoleArtKinds) {
    testWidgets('$kind renders and animates without error', (
      WidgetTester tester,
    ) async {
      debugRoleArtAnimationsEnabled = true;
      addTearDown(() => debugRoleArtAnimationsEnabled = false);
      await tester.pumpWidget(host(RoleArtBanner(roleKind: kind)));
      expect(find.byKey(ValueKey<String>('roleArt:$kind')), findsOneWidget);
      // 3:1 canvas at the given width.
      expect(
        tester.getSize(find.byType(CustomPaint).last),
        const Size(300, 100),
      );
      // Paint a few frames across the loop.
      for (int i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 700));
      }
      expect(tester.takeException(), isNull);
      expect(tester.hasRunningAnimations, isTrue);
    });
  }

  testWidgets('an unknown role_kind draws the generic art', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(host(const RoleArtBanner(roleKind: 'crane_op')));
    expect(
      find.byKey(const ValueKey<String>('roleArt:generic')),
      findsOneWidget,
    );
  });

  testWidgets('reduce motion: rest pose, no ticker', (
    WidgetTester tester,
  ) async {
    debugRoleArtAnimationsEnabled = true;
    addTearDown(() => debugRoleArtAnimationsEnabled = false);
    await tester.pumpWidget(
      host(const RoleArtBanner(roleKind: 'welder'), disableAnimations: true),
    );
    await tester.pump(const Duration(seconds: 1));
    expect(tester.hasRunningAnimations, isFalse);
    final RoleArtPainter painter =
        tester
                .widget<CustomPaint>(
                  find.byKey(const ValueKey<String>('roleArt:welder')),
                )
                .painter!
            as RoleArtPainter;
    expect(painter.progress.value, 0);
  });

  testWidgets('animate: false and TickerMode off both hold still', (
    WidgetTester tester,
  ) async {
    debugRoleArtAnimationsEnabled = true;
    addTearDown(() => debugRoleArtAnimationsEnabled = false);
    await tester.pumpWidget(
      host(const RoleArtBanner(roleKind: 'welder', animate: false)),
    );
    expect(tester.hasRunningAnimations, isFalse);
    await tester.pumpWidget(
      host(
        const TickerMode(
          enabled: false,
          child: RoleArtBanner(roleKind: 'cnc_turner'),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.hasRunningAnimations, isFalse);
  });

  testWidgets('switching the role swaps the art (and its loop)', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(host(const RoleArtBanner(roleKind: 'welder')));
    await tester.pumpWidget(host(const RoleArtBanner(roleKind: 'fitter')));
    expect(
      find.byKey(const ValueKey<String>('roleArt:fitter')),
      findsOneWidget,
    );
  });

  test(
    'every motion rests at its first keyframe (the reduce-motion frame)',
    () {
      for (final String kind in kRoleArtKinds) {
        for (final RoleArtPart part in roleArtDef(kind).parts) {
          final RoleArtMotion? m = part.motion;
          if (m == null) continue;
          expect(
            m.spec.valueAt(m.amp, 0),
            m.spec.base,
            reason: '$kind/${part.name}',
          );
        }
      }
    },
  );

  testWidgets('the list card draws the art only when asked (Jobs tab)', (
    WidgetTester tester,
  ) async {
    const BbJobCardData data = BbJobCardData(
      title: 'Welder',
      place: 'Pune',
      roleKind: 'welder',
    );
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: BbJobCard(data: data)),
      ),
    );
    expect(find.byType(RoleArtBanner), findsNothing);
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: BbJobCard(data: data, showRoleArt: true)),
      ),
    );
    expect(
      find.byKey(const ValueKey<String>('roleArt:welder')),
      findsOneWidget,
    );
  });
}
