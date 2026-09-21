import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/design2_cities_page.dart';

/// RENDER-ONLY coverage for the DESIGN2 preferred-cities picker. The page owns
/// no selection state: every tap must reach the caller's callback with the
/// canonical city value, and the hub/popular sections must disappear when the
/// caller has no catalogue data.
void main() {
  late TextEditingController search;
  late TextEditingController city;
  late List<String> toggled;
  late List<String> removed;
  late List<String> statesPicked;

  setUp(() {
    search = TextEditingController();
    city = TextEditingController();
    toggled = <String>[];
    removed = <String>[];
    statesPicked = <String>[];
  });

  tearDown(() {
    search.dispose();
    city.dispose();
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
    String? searchError,
    String? cityError,
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
                onSearchSubmit: () {},
                cityController: city,
                onCityChanged: (_) {},
                onCitySubmit: () {},
                onSelectState: statesPicked.add,
                onToggleHub: toggled.add,
                onRemoveCity: removed.add,
                searchError: searchError,
                cityError: cityError,
              ),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('renders the design chrome: title, counter badge, states, hubs',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    expect(find.text('Kahan kaam karna chahte hain?'), findsOneWidget);
    expect(find.text('1/5 Sheher Chune'), findsOneWidget);
    expect(find.text('INDUSTRIAL STATES'), findsOneWidget);
    expect(find.text('MAHARASHTRA HUBS'), findsOneWidget);
    expect(find.text('Chakan, Bhosari MIDC'), findsOneWidget);
    expect(find.text('Jodein'), findsOneWidget);
    expect(find.text('Chuna hua'), findsOneWidget);
  });

  testWidgets('tapping a hub reports the canonical city value',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    await tester.tap(find.text('Pune'));
    await tester.pump();
    expect(toggled, <String>['Pune']);
  });

  testWidgets('tapping a state chip reports the state',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    await tester.tap(find.text('Gujarat'));
    await tester.pump();
    expect(statesPicked, <String>['Gujarat']);
  });

  testWidgets('a picked city renders as a removable chip',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness());
    expect(find.text('CHUNE HUE SHEHER'), findsOneWidget);
    expect(find.byIcon(Icons.close_rounded), findsOneWidget);
    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pump();
    expect(removed, <String>['Nashik']);
  });

  testWidgets('hides the picked strip and hub fallback note when empty',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness(
      selected: const <String>[],
      hubs: const <Design2Hub>[],
    ));
    expect(find.text('CHUNE HUE SHEHER'), findsNothing);
    expect(find.text('0/5 Sheher Chune'), findsOneWidget);
    expect(find.textContaining('jald aa rahe hain'), findsOneWidget);
  });

  testWidgets('renders the popular factory hubs row when present',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness(popular: const <Design2Hub>[
      Design2Hub(
        cityValue: 'Manesar',
        title: 'NCR',
        areas: 'Manesar / Gurugram',
        selected: false,
      ),
    ]));
    expect(find.text('POPULAR FACTORY HUBS'), findsOneWidget);
    expect(find.text('NCR: Manesar / Gurugram'), findsOneWidget);
  });

  testWidgets('shows the caller\'s resolution errors verbatim',
      (WidgetTester tester) async {
    await tester.pumpWidget(harness(
      searchError: 'Yeh sheher list mein nahi mila',
      cityError: 'Yeh sheher list mein nahi mila',
    ));
    expect(find.text('Yeh sheher list mein nahi mila'), findsNWidgets(2));
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
