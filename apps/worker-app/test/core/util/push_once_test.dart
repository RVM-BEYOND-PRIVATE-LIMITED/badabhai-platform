import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:badabhai_worker_app/core/util/push_once.dart';

/// #1474 — a worker taps twice when a screen does not appear instantly, and
/// both taps were honoured: the same screen stacked on itself, and the back
/// button then appeared not to work because it only dismissed the duplicate.
void main() {
  late GoRouter router;

  Widget page(String label) => Scaffold(
        body: Builder(
          builder: (BuildContext context) => Column(
            children: <Widget>[
              Text(label),
              TextButton(
                onPressed: () => context.pushOnce('/second'),
                child: const Text('go second'),
              ),
              TextButton(
                onPressed: () => context.pushOnce('/third'),
                child: const Text('go third'),
              ),
            ],
          ),
        ),
      );

  Future<void> pump(WidgetTester tester) async {
    router = GoRouter(
      initialLocation: '/first',
      routes: <RouteBase>[
        GoRoute(path: '/first', builder: (_, __) => page('FIRST')),
        GoRoute(path: '/second', builder: (_, __) => page('SECOND')),
        GoRoute(path: '/third', builder: (_, __) => page('THIRD')),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
  }

  int depth() => router.routerDelegate.currentConfiguration.matches.length;

  testWidgets('a normal push still works', (WidgetTester tester) async {
    await pump(tester);
    await tester.tap(find.text('go second'));
    await tester.pumpAndSettle();

    expect(find.text('SECOND'), findsOneWidget);
    expect(depth(), 2);
  });

  testWidgets('pushing the screen that is ALREADY on top is refused',
      (WidgetTester tester) async {
    await pump(tester);
    await tester.tap(find.text('go second'));
    await tester.pumpAndSettle();
    expect(depth(), 2);

    // The worker is on /second and taps its own "go second" again.
    await tester.tap(find.text('go second'));
    await tester.pumpAndSettle();

    expect(depth(), 2, reason: '/second must not stack on itself');
    expect(find.text('SECOND'), findsOneWidget);
  });

  testWidgets('a double-tap opens the screen ONCE', (WidgetTester tester) async {
    await pump(tester);

    // Two taps with only a frame between them — a real thumb on a slow phone.
    await tester.tap(find.text('go second'));
    await tester.pump();
    // No warnIfMissed escape: if this tap ever stops landing, the test is
    // vacuous and must fail loudly rather than pass by accident.
    await tester.tap(find.text('go second').first);
    await tester.pumpAndSettle();

    expect(depth(), 2, reason: 'the second tap must not stack a duplicate');
  });

  testWidgets('back returns to the caller in ONE press after a double-tap',
      (WidgetTester tester) async {
    // The symptom the worker actually reports: back "does not work", because
    // it was dismissing an invisible duplicate.
    await pump(tester);
    await tester.tap(find.text('go second'));
    await tester.pump();
    await tester.tap(find.text('go second').first);
    await tester.pumpAndSettle();

    router.pop();
    await tester.pumpAndSettle();

    expect(find.text('FIRST'), findsOneWidget);
  });

  testWidgets('a DIFFERENT screen still pushes on top',
      (WidgetTester tester) async {
    await pump(tester);
    await tester.tap(find.text('go second'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('go third'));
    await tester.pumpAndSettle();

    expect(find.text('THIRD'), findsOneWidget);
    expect(depth(), 3);
  });
}
