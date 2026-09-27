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

  // #1784 — the guard read `matches.last`, which inside a StatefulShellRoute is
  // the ShellRouteMatch. Its `matchedLocation` is pinned at the shell's own
  // location and never moves for a push INSIDE the branch, so the comparison
  // never matched and a double tap stacked two copies of "Mere resume" /
  // "Interview kit". This is the shape the app actually ships: every bottom-nav
  // route lives in a branch.
  group('inside a StatefulShellRoute branch (#1784)', () {
    late GoRouter shellRouter;
    late BuildContext branchContext;

    Future<void> pumpShell(WidgetTester tester) async {
      shellRouter = GoRouter(
        initialLocation: '/tab',
        routes: <RouteBase>[
          StatefulShellRoute.indexedStack(
            builder: (_, __, StatefulNavigationShell shell) => shell,
            branches: <StatefulShellBranch>[
              StatefulShellBranch(
                routes: <RouteBase>[
                  GoRoute(
                    path: '/tab',
                    builder: (_, __) => Scaffold(
                      body: Builder(
                        builder: (BuildContext context) {
                          branchContext = context;
                          return const Text('BRANCH ROOT');
                        },
                      ),
                    ),
                    routes: <RouteBase>[
                      GoRoute(
                        path: 'detail',
                        builder: (_, __) => const Scaffold(
                          body: Center(child: Text('DETAIL')),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      );
      addTearDown(shellRouter.dispose);
      await tester.pumpWidget(MaterialApp.router(routerConfig: shellRouter));
      await tester.pumpAndSettle();
    }

    String leaf() =>
        shellRouter.routerDelegate.currentConfiguration.lastOrNull
            ?.matchedLocation ??
        '';

    /// How many routes the BRANCH's own navigator is holding.
    ///
    /// Counted off the match tree, NOT the widget tree: an `indexedStack` shell
    /// keeps every branch root mounted, so `find.text('BRANCH ROOT')` succeeds
    /// whether or not a duplicate detail page is sitting on top of it and cannot
    /// tell one copy from two. The route stack can.
    int branchDepth() {
      int count(List<RouteMatchBase> matches) {
        int n = 0;
        for (final RouteMatchBase m in matches) {
          if (m is ShellRouteMatch) {
            n += count(m.matches);
          } else {
            n += 1;
          }
        }
        return n;
      }

      return count(shellRouter.routerDelegate.currentConfiguration.matches);
    }

    testWidgets('a double tap on an in-branch route opens it ONCE',
        (WidgetTester tester) async {
      await pumpShell(tester);
      expect(branchDepth(), 1);

      // BOTH CALLS BEFORE A FRAME, which is what the real double tap is: the
      // worker's second tap is delivered while the first pushed route has not
      // painted yet. Driven through the context rather than `tester.tap`
      // because the pushed page immediately covers the button, so a second
      // `tap` would silently MISS the hit test and test nothing at all.
      branchContext.pushOnce('/tab/detail');
      branchContext.pushOnce('/tab/detail');
      await tester.pumpAndSettle();

      expect(find.text('DETAIL'), findsOneWidget);
      expect(leaf(), '/tab/detail');
      // THE ASSERTION THAT CATCHES #1784: root + ONE detail. Before the fix this
      // was 3 — `matches.last` reported the ShellRouteMatch's pinned `/tab` for
      // both calls, so the second was never recognised as a duplicate.
      expect(branchDepth(), 2);

      // And so ONE pop really does return to the branch root instead of
      // uncovering the second copy, which is the "back does not work" a worker
      // reports.
      shellRouter.pop();
      await tester.pumpAndSettle();
      expect(leaf(), '/tab');
      expect(branchDepth(), 1);
    });

    testWidgets('a first push inside a branch is still honoured',
        (WidgetTester tester) async {
      await pumpShell(tester);
      branchContext.pushOnce('/tab/detail');
      await tester.pumpAndSettle();

      expect(find.text('DETAIL'), findsOneWidget);
      expect(branchDepth(), 2);
    });

    testWidgets('a DIFFERENT in-branch route still stacks',
        (WidgetTester tester) async {
      await pumpShell(tester);
      branchContext.pushOnce('/tab/detail');
      branchContext.pushOnce('/tab');
      await tester.pumpAndSettle();

      expect(branchDepth(), 3);
    });
  });
}
