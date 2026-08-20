// The chat composer's LISTENING row. Three icon-only controls-and-cues, and a
// worker who cannot read a glyph has to be told what each one is.
//
// The thing under test is the SEMANTICS TREE THAT IS BUILT, not the source. A
// `Semantics(label: …)` wrapped around an `IconButton` reads like a name and is
// not one: the button is its own semantics boundary, so the label lands on a
// separate, non-interactive parent node and the button underneath keeps an empty
// name. Measured, that shape produced two focus stops per control and the one a
// screen reader lands on was the nameless one. So these assertions go through
// the built nodes and check the flags and the action, which is the only way to
// tell the two shapes apart.
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/voice/presentation/widgets/dictation_bar.dart';

void main() {
  late int stops;
  late int sends;
  late ValueNotifier<double> level;

  setUp(() {
    stops = 0;
    sends = 0;
    level = ValueNotifier<double>(0.4);
  });

  tearDown(() => level.dispose());

  Future<void> pumpBar(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: DictationBar(
          level: level,
          onStop: () => stops++,
          onSend: () => sends++,
        ),
      ),
    ));
    // NOT pumpAndSettle: the waveform animates forever, so settling never
    // returns.
    await tester.pump();
    await tester.pump();
  }

  testWidgets('Stop and Send are each ONE named, tappable BUTTON node', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    await pumpBar(tester);

    for (final String label in <String>[
      DictationBar.kStopLabel,
      DictationBar.kSendLabel,
    ]) {
      final Finder node = find.bySemanticsLabel(label);
      expect(node, findsOneWidget,
          reason: '$label must be announced exactly once, not twice');

      final SemanticsData data = tester.getSemantics(node).getSemanticsData();
      expect(data.label, label);
      expect(data.flagsCollection.isButton, isTrue,
          reason: 'a labelled node that is not a button is not the control — '
              'the control is then the nameless node underneath it');
      expect(data.hasAction(SemanticsAction.tap), isTrue,
          reason: 'a screen reader must be able to ACTIVATE what it named');
    }

    handle.dispose();
  });

  testWidgets('naming them did not take their taps away', (
    WidgetTester tester,
  ) async {
    // Excluding the button's own semantics must never touch hit testing — the
    // control still has to work for the worker who can see it.
    await pumpBar(tester);

    await tester.tap(find.byIcon(Icons.stop_circle_rounded));
    await tester.pump();
    expect(stops, 1);
    expect(sends, 0);

    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();
    expect(sends, 1);
    expect(stops, 1);
  });

  testWidgets('the waveform is ANNOUNCED as a live region, not just painted', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    await pumpBar(tester);

    // A CustomPaint carries no semantics of its own, so without this the most
    // important state on the surface — the mic is hot — reaches a blind worker
    // as nothing at all, and only when they happen to swipe onto it.
    final SemanticsData wave = tester
        .getSemantics(find.bySemanticsLabel(DictationBar.kListeningLabel))
        .getSemanticsData();
    expect(wave.label, DictationBar.kListeningLabel);
    expect(wave.flagsCollection.isLiveRegion, isTrue);

    handle.dispose();
  });
}
