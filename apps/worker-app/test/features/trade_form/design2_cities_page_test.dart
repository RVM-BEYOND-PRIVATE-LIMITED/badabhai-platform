import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/design2_cities_page.dart';

/// RENDER-ONLY coverage for the CITY1 preferred-cities picker. The page owns
/// no selection state: every tap must reach the caller's callback with the
/// canonical city value, and the hub/popular sections must disappear when the
/// caller has no catalogue data. The question heading is untouched by the
/// city1 restyle; everything below it follows `city1.png`.
void main() {
  late TextEditingController search;
  late List<String> toggled;
  late List<String> removed;
  late List<String> statesPicked;

  setUp(() {
    search = TextEditingController();
    toggled = <String>[];
    removed = <String>[];
    statesPicked = <String>[];
  });

  tearDown(() {
    search.dispose();
  });

  const List<String> kStates = <String>['Maharashtra', 'Gujarat'];
  const List<Design2Hub> kHubs = <Design2Hub>[
    Design2Hub(
      cityValue: 'Pune',
      title: 'Pune',
      areas: 'Chakan, Bhosari MIDC',
      selected: false,
    ),
    Design2Hub(
      cityValue: 'Nashik',
      title: 'Nashik',
      areas: 'Ambad & Satpur MIDC',
      selected: true,
    ),
  ];

  Widget harness({
    List<String> selected = const <String>['Nashik'],
    List<Design2Hub> hubs = kHubs,
    List<Design2Hub> popular = const <Design2Hub>[],
    List<Design2Hub> results = const <Design2Hub>[],
    String? selectedState = 'Maharashtra',
    double textScale = 1.0,
  }) {
    return MaterialApp(
      home: Builder(
        builder: (BuildContext context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            textScaler: TextScaler.linear(textScale),
          ),
          child: Scaffold(
            body: SingleChildScrollView(
              child: Design2CitiesPage(
                maxCities: 5,
                selectedCities: selected,
                states: kStates,
                selectedState: selectedState,
                stateHubs: hubs,
                popularHubs: popular,
                searchResults: results,
                searchController: search,
                onSearchChanged: (_) {},
                onSelectState: statesPicked.add,
                onToggleHub: toggled.add,
                onRemoveCity: removed.add,
              ),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('renders the city1 chrome below the untouched question',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    // Question area — unchanged.
    expect(find.text('Kahan kaam karna chahte hain?'), findsOneWidget);
    expect(find.text('1/5 Sheher Chune'), findsOneWidget);
    // City1 body.
    expect(find.text('Selected locations'), findsOneWidget);
    expect(find.text('1/5 locations selected'), findsOneWidget);
    expect(find.text('Clear all'), findsOneWidget);
    expect(find.text('State Chunain'), findsOneWidget);
    expect(find.text('POPULAR STATES'), findsOneWidget);
    expect(find.text('Cities Chunain'), findsOneWidget);
    expect(find.text('Popular cities from selected state'), findsOneWidget);
    expect(find.text('Pune'), findsOneWidget);
    // Grid cells show the city name only — area sub-labels stay hidden.
    expect(find.text('Chakan, Bhosari MIDC'), findsNothing);
    expect(find.text('Selected cities (max 5)'), findsOneWidget);
  });

  testWidgets('tapping a city cell reports the canonical city value',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    await tester.tap(find.text('Pune'));
    await tester.pump();
    expect(toggled, <String>['Pune']);
  });

  testWidgets('tapping a popular state chip reports the state',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    await tester.tap(find.text('Gujarat'));
    await tester.pump();
    expect(statesPicked, <String>['Gujarat']);
  });

  testWidgets('a picked city renders as a removable chip',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    expect(find.text('Selected cities (max 5)'), findsOneWidget);
    // The picked strip sits at the foot of the cities card (city1), so it
    // may start below the fold — scroll it into view before tapping.
    await tester.ensureVisible(find.byIcon(Icons.close_rounded));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.close_rounded), findsOneWidget);
    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pump();
    expect(removed, <String>['Nashik']);
  });

  testWidgets('clear all removes every picked city',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness(
      selected: const <String>['Pune', 'Nashik'],
    ));
    await tester.tap(find.text('Clear all'));
    await tester.pump();
    expect(removed, <String>['Pune', 'Nashik']);
  });

  testWidgets('hides the picked chips and hub fallback note when empty',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness(
      selected: const <String>[],
      hubs: const <Design2Hub>[],
    ));
    expect(find.text('No cities selected yet'), findsOneWidget);
    expect(find.text('0/5 locations selected'), findsOneWidget);
    expect(find.text('0/5 Sheher Chune'), findsOneWidget);
    expect(find.textContaining('jald aa rahe hain'), findsOneWidget);
  });

  testWidgets('renders the other-cities rows when the catalogue has popular hubs',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness(popular: const <Design2Hub>[
      Design2Hub(
        cityValue: 'Manesar',
        title: 'NCR',
        areas: 'Manesar / Gurugram',
        selected: false,
      ),
    ]));
    expect(find.text('Other best places'), findsOneWidget);
    expect(find.text('NCR: Manesar / Gurugram'), findsOneWidget);
  });

  testWidgets('typing is the search: no Dhoondhein button, no "Koi sheher?" '
      'box, and no not-found error', (WidgetTester tester) async {
    // A worker typing "Kol" was shown a red "this city was not in the list"
    // while Kolhapur and Kolkata sat in the cards right underneath it. The
    // cards ARE the answer, so the submit button, the second text box and the
    // error line are gone and tapping a card is the only add path.
    await tester.pumpWidget(harness(results: kHubs));

    expect(find.text('Dhoondhein'), findsNothing);
    expect(find.text('Koi sheher?'), findsNothing);
    expect(find.text('Apna sheher likhein'), findsNothing);
    expect(find.textContaining('nahi mila'), findsNothing);
    // Exactly one text field on the page now: the browse box.
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('SEARCH RESULTS'), findsOneWidget);
  });

  testWidgets('State card sits ABOVE the city results',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness(results: kHubs));

    final double state = tester.getTopLeft(find.text('State Chunain')).dy;
    final double results = tester.getTopLeft(find.text('SEARCH RESULTS')).dy;
    expect(state, lessThan(results),
        reason: 'the state narrows the cities, so it comes first');
  });

  testWidgets('no overflow on a 320x568 handset at 2.0 text scale',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(harness(textScale: 2.0));
    expect(tester.takeException(), isNull);
  });
}
