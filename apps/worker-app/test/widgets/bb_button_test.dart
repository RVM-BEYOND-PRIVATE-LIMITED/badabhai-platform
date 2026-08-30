import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbButton', () {
    testWidgets('renders its label and fires onPressed', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbButton(label: 'Apply', onPressed: () => taps++),
      ));

      expect(find.text('Apply'), findsOneWidget);
      await tester.tap(find.text('Apply'));
      expect(taps, 1);
    });

    testWidgets('primary variant renders a FilledButton (theme-driven green)',
        (tester) async {
      await tester.pumpWidget(_host(
        BbButton(label: 'Go', onPressed: () {}),
      ));
      expect(find.widgetWithText(FilledButton, 'Go'), findsOneWidget);
    });

    testWidgets('secondary variant renders an OutlinedButton', (tester) async {
      await tester.pumpWidget(_host(
        BbButton(
          label: 'Skip',
          variant: BbButtonVariant.secondary,
          onPressed: () {},
        ),
      ));
      expect(find.widgetWithText(OutlinedButton, 'Skip'), findsOneWidget);
    });

    testWidgets('loading shows a spinner and blocks taps', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbButton(label: 'Sending', loading: true, onPressed: () => taps++),
      ));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.text('Sending'));
      expect(taps, 0); // disabled while loading
    });

    testWidgets('passes buttonKey through for test/lookup', (tester) async {
      await tester.pumpWidget(_host(
        BbButton(
          label: 'Tap',
          buttonKey: const Key('myBtn'),
          onPressed: () {},
        ),
      ));
      expect(find.byKey(const Key('myBtn')), findsOneWidget);
    });

    // #1364 — server-supplied CTA copy (e.g. the trade-form handover card's
    // "Form bharkar resume pura karein") can run long. `_Content`'s label
    // Text hardcodes `overflow: ellipsis`, which — per Flutter's own rule —
    // behaves as `maxLines: 1` whenever `maxLines` is left unset, truncating
    // it. `allowMultilineLabel` is the opt-in escape hatch.
    group('allowMultilineLabel (#1364)', () {
      const String longLabel =
          'Form bharkar apna resume pura karein aur naukri paayein jaldi se';

      testWidgets(
          'default (omitted) keeps single-line ellipsis — no regression to '
          'existing call sites', (tester) async {
        await tester.pumpWidget(_host(
          SizedBox(
            width: 300,
            child: BbButton(label: longLabel, block: true, onPressed: () {}),
          ),
        ));

        final Text text = tester.widget<Text>(find.text(longLabel));
        expect(text.overflow, TextOverflow.ellipsis);
        expect(text.maxLines, isNull,
            reason: 'unset maxLines + ellipsis already truncates to one '
                'line — the documented Flutter behaviour this bug relied on');
      });

      testWidgets('allowMultilineLabel: true does not truncate a long label',
          (tester) async {
        await tester.pumpWidget(_host(
          SizedBox(
            width: 300,
            child: BbButton(
              label: longLabel,
              block: true,
              allowMultilineLabel: true,
              onPressed: () {},
            ),
          ),
        ));

        // The full label is still the ONE literal string rendered (Text
        // never rewrites/shortens server copy) — this just asserts it is
        // configured to actually show, not silently clip, all of it.
        expect(find.text(longLabel), findsOneWidget);
        final Text text = tester.widget<Text>(find.text(longLabel));
        expect(text.maxLines, 2);
        expect(text.softWrap, isTrue);
        expect(text.overflow, TextOverflow.ellipsis,
            reason: 'kept as a safety net if it still does not fit');
      });

      testWidgets(
          'allowMultilineLabel: true lets the button grow taller than the '
          'single-line default — minimumSize is a floor, not a fixed size',
          (tester) async {
        Future<Size> heightOf({required bool multiline}) async {
          await tester.pumpWidget(_host(
            SizedBox(
              width: 300,
              child: BbButton(
                label: longLabel,
                block: true,
                allowMultilineLabel: multiline,
                onPressed: () {},
              ),
            ),
          ));
          await tester.pumpAndSettle();
          return tester.getSize(find.byType(FilledButton));
        }

        final Size singleLine = await heightOf(multiline: false);
        final Size multiLine = await heightOf(multiline: true);

        expect(
          multiLine.height,
          greaterThan(singleLine.height),
          reason: 'a taller (wrapped) child must grow the button, not get '
              'clipped inside a fixed-height shell',
        );
      });
    });
  });
}
