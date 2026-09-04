import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/name/domain/location_lookup.dart';
import 'package:badabhai_worker_app/features/name/domain/name_repository.dart';
import 'package:badabhai_worker_app/features/name/presentation/cubit/name_cubit.dart';
import 'package:badabhai_worker_app/features/name/presentation/name_screen.dart';
import 'package:badabhai_worker_app/router.dart';

const String _kChatMarker = 'CHAT_SCREEN_MARKER';

class MockNameRepository extends Mock implements NameRepository {}

class MockLocationLookup extends Mock implements LocationLookup {}

Future<void> _pump(
  WidgetTester tester, {
  required MockNameRepository repo,
  required MockLocationLookup locationLookup,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  registerFallbackValue('');
  when(() => repo.submitName(any(),
      city: any(named: 'city'),
      state: any(named: 'state'),
      address: any(named: 'address'))).thenAnswer((_) async {});
  locator.registerFactory<NameRepository>(() => repo);
  locator.registerFactory<NameCubit>(() => NameCubit(locator<NameRepository>()));
  locator.registerLazySingleton<LocationLookup>(() => locationLookup);

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final GoRouter router = GoRouter(
    initialLocation: '/name',
    routes: <RouteBase>[
      GoRoute(path: '/name', builder: (_, __) => const NameScreen()),
      GoRoute(
        path: Routes.chatProfiling,
        builder: (_, __) => const Scaffold(body: Text(_kChatMarker)),
      ),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
  );
  await tester.pump();
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
      'renders separate first/last name fields, no single "poora naam" field',
      (WidgetTester tester) async {
    await _pump(tester, repo: MockNameRepository(), locationLookup: MockLocationLookup());

    expect(find.text('PEHLA NAAM'), findsOneWidget);
    expect(find.text('AAKHRI NAAM'), findsOneWidget);
    expect(find.byType(TextField), findsNWidgets(2));
  });

  testWidgets('Continue stays disabled until name AND location are both present',
      (WidgetTester tester) async {
    await _pump(tester, repo: MockNameRepository(), locationLookup: MockLocationLookup());

    final Finder continueButton = find.widgetWithText(FilledButton, 'Continue');
    expect(tester.widget<FilledButton>(continueButton).onPressed, isNull);

    final Finder nameFields = find.byType(TextField);
    await tester.enterText(nameFields.at(0), 'Asha');
    await tester.enterText(nameFields.at(1), 'Kumari');
    await tester.pump();
    // Name alone is not enough — location is mandatory too.
    expect(tester.widget<FilledButton>(continueButton).onPressed, isNull);

    await tester.tap(find.text('Khud likhein'));
    await tester.pump();
    final Finder addressField = find.byType(TextField).at(2);
    await tester.enterText(addressField, 'G32, Kalwar Road, Jaipur, Rajasthan');
    await tester.pump();
    expect(tester.widget<FilledButton>(continueButton).onPressed, isNotNull);
  });

  testWidgets(
      'a successful GPS resolve shows a summary card and submits the resolved city/state',
      (WidgetTester tester) async {
    final MockNameRepository repo = MockNameRepository();
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenAnswer(
      (_) async => const ResolvedLocation(city: 'Pune', state: 'Maharashtra'),
    );
    await _pump(tester, repo: repo, locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump(); // loading frame
    await tester.pump(); // resolveCurrent() resolves

    expect(find.text('Pune, Maharashtra'), findsOneWidget);
    expect(find.text('Badlein'), findsOneWidget);

    final Finder nameFields = find.byType(TextField);
    await tester.enterText(nameFields.at(0), 'Asha');
    await tester.enterText(nameFields.at(1), 'Kumari');
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();

    verify(() => repo.submitName('Asha Kumari',
            city: 'Pune', state: 'Maharashtra', address: null))
        .called(1);
  });

  testWidgets(
      'a GPS failure degrades honestly to manual entry instead of getting stuck',
      (WidgetTester tester) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenThrow(
      const LocationLookupFailure(LocationLookupFailureReason.permissionDenied),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('Location ki permission nahi mili. Neeche khud likhein.'),
        findsOneWidget);
    // Dropped straight into manual entry (one address line, not two
    // city/state boxes) — the worker is never stranded.
    expect(find.byType(TextField), findsNWidgets(3));
  });

  testWidgets(
      'manual address entry submits address only, never a parsed city/state',
      (WidgetTester tester) async {
    final MockNameRepository repo = MockNameRepository();
    await _pump(tester, repo: repo, locationLookup: MockLocationLookup());

    final Finder nameFields = find.byType(TextField);
    await tester.enterText(nameFields.at(0), 'Asha');
    await tester.enterText(nameFields.at(1), 'Kumari');
    await tester.tap(find.text('Khud likhein'));
    await tester.pump();
    await tester.enterText(find.byType(TextField).at(2),
        'g32, mangalam city, kalwar road, jaipur, rajasthan');
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();

    verify(() => repo.submitName('Asha Kumari',
            city: null,
            state: null,
            address: 'G32, Mangalam City, Kalwar Road, Jaipur, Rajasthan'))
        .called(1);
  });
}
