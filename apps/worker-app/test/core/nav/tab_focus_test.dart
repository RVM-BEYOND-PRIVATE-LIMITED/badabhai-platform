import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/nav/tab_focus.dart';

/// T4 — StatefulShellRoute.indexedStack keeps every visited branch MOUNTED, so a
/// tab root's create:/initState runs exactly once. [TabFocusRefetch] is the
/// "this tab is visible again" signal that lets each root refetch.
void main() {
  late TabFocus focus;
  late int calls;

  setUp(() {
    focus = TabFocus();
    calls = 0;
  });

  tearDown(() => focus.dispose());

  Future<void> pump(WidgetTester tester, int index) async {
    await tester.pumpWidget(
      MaterialApp(
        home: TabFocusRefetch(
          tabFocus: focus,
          index: index,
          onFocused: () => calls++,
          child: const SizedBox.shrink(),
        ),
      ),
    );
  }

  testWidgets('does NOT fire on mount — create: already loaded', (
    WidgetTester tester,
  ) async {
    focus.value = TabIndex.resume;
    await pump(tester, TabIndex.resume);

    expect(calls, 0,
        reason: 'firing here would double-load on a first visit');
  });

  testWidgets('fires when its tab becomes active', (WidgetTester tester) async {
    await pump(tester, TabIndex.resume); // focus starts on jobs

    focus.value = TabIndex.resume;
    await tester.pump();

    expect(calls, 1);
  });

  testWidgets('ignores other tabs becoming active', (
    WidgetTester tester,
  ) async {
    await pump(tester, TabIndex.resume);

    focus.value = TabIndex.profile;
    focus.value = TabIndex.alerts;
    await tester.pump();

    expect(calls, 0, reason: 'only this tab’s own focus counts');
  });

  testWidgets('fires again on every RE-focus, not just the first', (
    WidgetTester tester,
  ) async {
    await pump(tester, TabIndex.alerts);

    focus.value = TabIndex.alerts; // away → here
    focus.value = TabIndex.jobs;
    focus.value = TabIndex.alerts;
    await tester.pump();

    expect(calls, 2, reason: 'a mounted branch must refetch on each return');
  });

  testWidgets('stops listening once disposed', (WidgetTester tester) async {
    await pump(tester, TabIndex.resume);
    await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));

    focus.value = TabIndex.resume;
    await tester.pump();

    expect(calls, 0);
  });

  test('the tab indices match the shell branch order', () {
    // Jobs / Resume / Profile / Alerts — the order in router.dart's branches and
    // in BbBottomNav. A silent reorder here would refetch the wrong tab.
    expect(
      <int>[TabIndex.jobs, TabIndex.resume, TabIndex.profile, TabIndex.alerts],
      <int>[0, 1, 2, 3],
    );
  });
}
