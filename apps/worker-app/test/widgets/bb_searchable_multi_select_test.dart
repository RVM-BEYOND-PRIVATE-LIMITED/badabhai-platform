import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/core/widgets/bb_searchable_multi_select.dart';

// Scrollable, not `Center` — the real widget sits inside a scrolling question
// screen, and a 23-option Wrap legitimately exceeds the 600px test viewport;
// a bare `Center` would report that as a RenderFlex overflow that has nothing
// to do with the behaviour under test.
Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

/// The 23-material list the CNC turner form (#1341) will hand this widget —
/// close enough to the real pack to exercise the >12 "searchable" case, plus
/// one Devanagari label to prove matching survives non-Latin script.
final List<BbSelectOption> _materials = <BbSelectOption>[
  const BbSelectOption(key: 'mat_ms', label: 'Mild Steel'),
  const BbSelectOption(key: 'mat_ss', label: 'Stainless Steel'),
  const BbSelectOption(key: 'mat_al', label: 'Aluminium'),
  const BbSelectOption(key: 'mat_brass', label: 'Brass'),
  const BbSelectOption(key: 'mat_bronze', label: 'Bronze'),
  const BbSelectOption(key: 'mat_copper', label: 'Copper'),
  const BbSelectOption(key: 'mat_castiron', label: 'Cast Iron'),
  const BbSelectOption(key: 'mat_titanium', label: 'Titanium'),
  const BbSelectOption(key: 'mat_nickel', label: 'Nickel Alloy'),
  const BbSelectOption(key: 'mat_carbonsteel', label: 'Carbon Steel'),
  const BbSelectOption(key: 'mat_toolsteel', label: 'Tool Steel'),
  const BbSelectOption(key: 'mat_alloysteel', label: 'Alloy Steel'),
  const BbSelectOption(key: 'mat_zinc', label: 'Zinc'),
  const BbSelectOption(key: 'mat_lead', label: 'Lead'),
  const BbSelectOption(key: 'mat_magnesium', label: 'Magnesium'),
  const BbSelectOption(key: 'mat_pvc', label: 'PVC'),
  const BbSelectOption(key: 'mat_nylon', label: 'Nylon'),
  const BbSelectOption(key: 'mat_teflon', label: 'Teflon'),
  const BbSelectOption(key: 'mat_delrin', label: 'Delrin'),
  const BbSelectOption(key: 'mat_hastelloy', label: 'Hastelloy'),
  const BbSelectOption(key: 'mat_inconel', label: 'Inconel'),
  const BbSelectOption(key: 'mat_duplex', label: 'Duplex Steel'),
  // Devanagari label — a regional-language pack item.
  const BbSelectOption(key: 'mat_peetal', label: 'पीतल'),
];

void main() {
  group('BbSearchableMultiSelect', () {
    testWidgets('renders every option as a chip up front', (tester) async {
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>[],
          onChanged: (_) {},
        ),
      ));

      expect(find.text('Mild Steel'), findsOneWidget);
      expect(find.text('Stainless Steel'), findsOneWidget);
      expect(find.text('पीतल'), findsOneWidget);
      expect(find.byType(BbChip), findsNWidgets(_materials.length));
    });

    testWidgets('typing filters the chip list to matching labels',
        (tester) async {
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>[],
          onChanged: (_) {},
        ),
      ));

      await tester.enterText(find.byType(TextField), 'steel');
      await tester.pump();

      expect(find.text('Mild Steel'), findsOneWidget);
      expect(find.text('Stainless Steel'), findsOneWidget);
      expect(find.text('Carbon Steel'), findsOneWidget);
      expect(find.text('Tool Steel'), findsOneWidget);
      expect(find.text('Alloy Steel'), findsOneWidget);
      expect(find.text('Duplex Steel'), findsOneWidget);
      // Non-matching options drop out of view.
      expect(find.text('Aluminium'), findsNothing);
      expect(find.text('Brass'), findsNothing);
      expect(find.text('पीतल'), findsNothing);
    });

    testWidgets('matching is case-insensitive', (tester) async {
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>[],
          onChanged: (_) {},
        ),
      ));

      await tester.enterText(find.byType(TextField), 'BRASS');
      await tester.pump();

      expect(find.text('Brass'), findsOneWidget);
    });

    testWidgets('a Devanagari label is findable by typing it', (tester) async {
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>[],
          onChanged: (_) {},
        ),
      ));

      await tester.enterText(find.byType(TextField), 'पीत');
      await tester.pump();

      expect(find.text('पीतल'), findsOneWidget);
      expect(find.text('Mild Steel'), findsNothing);
    });

    testWidgets('a selected chip stays visible even once filtered out by query',
        (tester) async {
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>['mat_brass'],
          onChanged: (_) {},
        ),
      ));

      // Filter to something that would otherwise hide Brass.
      await tester.enterText(find.byType(TextField), 'steel');
      await tester.pump();

      expect(find.text('Brass'), findsOneWidget); // still visible, selected
      expect(find.text('Mild Steel'), findsOneWidget); // matches the query
      expect(find.text('Aluminium'), findsNothing); // neither selected nor matching
    });

    testWidgets('shows the empty hint when nothing matches and nothing is selected',
        (tester) async {
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>[],
          onChanged: (_) {},
          emptyHint: 'Koi option nahi mila. Doosra shabd try karein.',
        ),
      ));

      await tester.enterText(find.byType(TextField), 'zzzznotfound');
      await tester.pump();

      expect(
        find.text('Koi option nahi mila. Doosra shabd try karein.'),
        findsOneWidget,
      );
    });

    testWidgets('tapping an unselected chip reports the KEY, not the label',
        (tester) async {
      List<String>? reported;
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>[],
          onChanged: (List<String> keys) => reported = keys,
        ),
      ));

      await tester.tap(find.text('Brass'));
      await tester.pump();

      expect(reported, <String>['mat_brass']);
    });

    testWidgets('tapping a selected chip toggles it off (removes the key)',
        (tester) async {
      List<String>? reported;
      await tester.pumpWidget(_host(
        BbSearchableMultiSelect(
          options: _materials,
          selectedKeys: const <String>['mat_brass', 'mat_al'],
          onChanged: (List<String> keys) => reported = keys,
        ),
      ));

      await tester.tap(find.text('Brass'));
      await tester.pump();

      expect(reported, <String>['mat_al']);
    });

    testWidgets('new picks are appended in tap order', (tester) async {
      List<String> selected = <String>['mat_al'];
      await tester.pumpWidget(StatefulBuilder(
        builder: (BuildContext context, StateSetter setState) {
          return _host(
            BbSearchableMultiSelect(
              options: _materials,
              selectedKeys: selected,
              onChanged: (List<String> keys) =>
                  setState(() => selected = keys),
            ),
          );
        },
      ));

      await tester.tap(find.text('Brass'));
      await tester.pump();
      await tester.tap(find.text('Copper'));
      await tester.pump();

      expect(selected, <String>['mat_al', 'mat_brass', 'mat_copper']);
    });

    testWidgets('changing resetKey clears the query but not the selection',
        (tester) async {
      Object resetKey = 'question-1';
      await tester.pumpWidget(StatefulBuilder(
        builder: (BuildContext context, StateSetter setState) {
          return _host(
            Column(
              children: <Widget>[
                BbSearchableMultiSelect(
                  options: _materials,
                  selectedKeys: const <String>['mat_brass'],
                  onChanged: (_) {},
                  resetKey: resetKey,
                ),
                TextButton(
                  onPressed: () => setState(() => resetKey = 'question-2'),
                  child: const Text('next question'),
                ),
              ],
            ),
          );
        },
      ));

      await tester.enterText(find.byType(TextField), 'steel');
      await tester.pump();
      expect(find.text('Mild Steel'), findsOneWidget);
      expect(find.text('Aluminium'), findsNothing);

      await tester.tap(find.text('next question'));
      await tester.pump();

      // The query is gone — every option is visible again.
      expect(find.byType(TextField), findsOneWidget);
      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller?.text, '');
      expect(find.text('Aluminium'), findsOneWidget);
      // The selection itself was untouched by the reset.
      expect(find.text('Brass'), findsOneWidget);
    });
  });
}
