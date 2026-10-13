// OWNER ASK (2026-10-12) — the free-chat "Resume banayein" action is the
// mock-up's gradient pill with a trailing arrow that ripples. This pins the
// contract that makes it safe to ship: label + glyphs render, a tap fires, and
// the looping ripple obeys the test seam (`debugResumeActionAnimationEnabled`,
// off in the suite harness) so it can never hold a `pumpAndSettle` open.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/presentation/widgets/resume_action_button.dart';

void main() {
  // Restore the SUITE harness default (off), never the production default, so a
  // later test file is not left with a looping ticker.
  tearDown(() => debugResumeActionAnimationEnabled = false);

  Future<void> pump(WidgetTester tester, {VoidCallback? onPressed}) =>
      tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: ResumeActionButton(
                label: 'Resume banayein',
                onPressed: onPressed,
              ),
            ),
          ),
        ),
      );

  testWidgets('renders the centered label and the trailing arrow', (
    WidgetTester tester,
  ) async {
    debugResumeActionAnimationEnabled = false;
    await pump(tester, onPressed: () {});
    await tester.pumpAndSettle();

    expect(find.text('Resume banayein'), findsOneWidget);
    expect(
      find.byIcon(Icons.contact_page_outlined),
      findsNothing,
      reason: 'the leading glyph was removed',
    );
    expect(find.byIcon(Icons.arrow_forward_rounded), findsOneWidget);
  });

  testWidgets('a tap fires onPressed', (WidgetTester tester) async {
    debugResumeActionAnimationEnabled = false;
    int taps = 0;
    await pump(tester, onPressed: () => taps++);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Resume banayein'));
    await tester.pumpAndSettle();
    expect(taps, 1);
  });

  testWidgets('seam OFF: no ticker — pumpAndSettle settles', (
    WidgetTester tester,
  ) async {
    debugResumeActionAnimationEnabled = false;
    await pump(tester, onPressed: () {});
    await tester.pumpAndSettle();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('seam ON: the ripple keeps looping', (WidgetTester tester) async {
    debugResumeActionAnimationEnabled = true;
    await pump(tester, onPressed: () {});
    await tester.pump(const Duration(milliseconds: 32));
    expect(tester.binding.hasScheduledFrame, isTrue);
  });

  testWidgets('a disabled button runs no ticker even with the seam on', (
    WidgetTester tester,
  ) async {
    debugResumeActionAnimationEnabled = true;
    await pump(tester); // onPressed null
    await tester.pumpAndSettle();
    expect(tester.binding.hasScheduledFrame, isFalse);
  });
}
