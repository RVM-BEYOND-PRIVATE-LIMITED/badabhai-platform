import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_sheet.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbBottomSheet', () {
    testWidgets('opens via showBbBottomSheet and renders its builder content',
        (tester) async {
      await tester.pumpWidget(_host(
        Builder(
          builder: (BuildContext ctx) => ElevatedButton(
            onPressed: () => showBbBottomSheet<void>(
              context: ctx,
              builder: (_) => const Text('Sheet!'),
            ),
            child: const Text('Open'),
          ),
        ),
      ));

      expect(find.text('Sheet!'), findsNothing);

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      expect(find.text('Sheet!'), findsOneWidget);
      expect(find.byType(BbSheetGrip), findsOneWidget);
    });

    testWidgets('BbSheetGrip renders a sized pill', (tester) async {
      await tester.pumpWidget(_host(const BbSheetGrip()));
      expect(find.byType(BbSheetGrip), findsOneWidget);
    });
  });

  // A sheet held open while `dismissible` reads false — e.g. while its save
  // is in flight. Back and the scrim ask the route to maybe-pop; a swipe down
  // pops it outright, so each is checked.
  group('showBbBottomSheet(dismissible:)', () {
    late ValueNotifier<bool> dismissible;
    late List<String?> results;

    setUp(() {
      dismissible = ValueNotifier<bool>(false);
      results = <String?>[];
    });

    Future<void> open(WidgetTester tester) async {
      await tester.pumpWidget(_host(
        Builder(
          builder: (BuildContext ctx) => ElevatedButton(
            onPressed: () async => results.add(
              await showBbBottomSheet<String>(
                context: ctx,
                dismissible: dismissible,
                builder: (_) => const _HeldSheetBody(),
              ),
            ),
            child: const Text('Open'),
          ),
        ),
      ));
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
    }

    testWidgets('held: back, a scrim tap and a swipe down leave it open',
        (tester) async {
      await open(tester);

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();
      await tester.fling(find.byType(BbSheetGrip), const Offset(0, 400), 2000);
      await tester.pumpAndSettle();

      expect(find.byType(_HeldSheetBody), findsOneWidget);
      expect(results, isEmpty);
    });

    testWidgets('held: the sheet itself can still close', (tester) async {
      await open(tester);

      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();

      expect(find.byType(_HeldSheetBody), findsNothing);
      expect(results, <String?>['done']);
    });

    testWidgets('let go: a swipe down closes it again', (tester) async {
      await open(tester);
      dismissible.value = true;
      await tester.pump();

      await tester.fling(find.byType(BbSheetGrip), const Offset(0, 400), 2000);
      await tester.pumpAndSettle();

      expect(find.byType(_HeldSheetBody), findsNothing);
      expect(results, <String?>[null]);
    });

    testWidgets('let go: back closes it again', (tester) async {
      await open(tester);
      dismissible.value = true;
      await tester.pump();

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      expect(find.byType(_HeldSheetBody), findsNothing);
      expect(results, <String?>[null]);
    });

    testWidgets('the content keeps its state while the hold changes',
        (tester) async {
      await open(tester);
      await tester.tap(find.text('Taps: 0'));
      await tester.pump();

      dismissible.value = true;
      await tester.pump();
      dismissible.value = false;
      await tester.pump();

      expect(find.text('Taps: 1'), findsOneWidget);
    });
  });
}

/// A sheet body with its own state (a tap count) and its own way out.
class _HeldSheetBody extends StatefulWidget {
  const _HeldSheetBody();

  @override
  State<_HeldSheetBody> createState() => _HeldSheetBodyState();
}

class _HeldSheetBodyState extends State<_HeldSheetBody> {
  int _taps = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        TextButton(
          onPressed: () => setState(() => _taps++),
          child: Text('Taps: $_taps'),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop('done'),
          child: const Text('Done'),
        ),
      ],
    );
  }
}
