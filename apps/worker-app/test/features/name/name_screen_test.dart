import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/onboarding_select_field.dart';
import 'package:badabhai_worker_app/features/name/domain/location_lookup.dart';
import 'package:badabhai_worker_app/features/name/domain/name_repository.dart';
import 'package:badabhai_worker_app/features/name/presentation/cubit/name_cubit.dart';
import 'package:badabhai_worker_app/features/name/presentation/name_screen.dart';
import 'package:badabhai_worker_app/router.dart';

const String _kChatMarker = 'CHAT_SCREEN_MARKER';
const String _kResumeUploadMarker = 'RESUME_UPLOAD_SCREEN_MARKER';
const String _kFeedbackMarker = 'FEEDBACK_SCREEN_MARKER';

/// Copy the prompt shows in each of its two roles (#1462).
const String _kSubmitPromptTitle = 'Location reh gayi';
const String _kResumePromptTitle = 'Location ab mil sakti hai';
const String _kSkipLabel = 'Bina location aage badhein';

/// Titles of the two picker sheets.
const String _kStateSheetTitle = 'State chunein';
const String _kCitySheetTitle = 'Sheher chunein';

class MockNameRepository extends Mock implements NameRepository {}

class MockLocationLookup extends Mock implements LocationLookup {}

Future<void> _pump(
  WidgetTester tester, {
  required MockNameRepository repo,
  required MockLocationLookup locationLookup,
  Size size = const Size(900, 1900),
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  registerFallbackValue('');
  when(
    () => repo.submitName(
      any(),
      city: any(named: 'city'),
      state: any(named: 'state'),
    ),
  ).thenAnswer((_) async {});
  // Default: GPS is NOT silently available, so the resume check never fires
  // unless a test opts in. Tests that never touch it still need the stub —
  // an unstubbed mocktail call would throw inside the lifecycle callback.
  when(() => locationLookup.isAvailable()).thenAnswer((_) async => false);
  locator.registerFactory<NameRepository>(() => repo);
  locator.registerFactory<NameCubit>(
    () => NameCubit(locator<NameRepository>()),
  );
  locator.registerLazySingleton<LocationLookup>(() => locationLookup);

  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final GoRouter router = GoRouter(
    initialLocation: '/name',
    routes: <RouteBase>[
      GoRoute(path: '/name', builder: (_, __) => const NameScreen()),
      // #1499 — `/name` now hands to the three-door résumé step, not straight
      // to the chat. BOTH are registered here: the résumé step because it is
      // where a successful submit actually lands, and the chat because two of
      // that screen's three doors still go there.
      GoRoute(
        path: Routes.resumeUpload,
        builder: (_, __) => const Scaffold(body: Text(_kResumeUploadMarker)),
      ),
      GoRoute(
        path: Routes.chatProfiling,
        builder: (_, __) => const Scaffold(body: Text(_kChatMarker)),
      ),
      // The screen's own Feedback pill pushes here; the marker echoes the
      // `extra` so a test can see which route was reported.
      GoRoute(
        path: Routes.feedback,
        builder: (_, GoRouterState state) =>
            Scaffold(body: Text('$_kFeedbackMarker ${state.extra}')),
      ),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
  );
  await tester.pump();
}

/// Two frames — one for the state change, one for the dialog / sheet route to
/// open. Deliberately NOT `pumpAndSettle`: the GPS button's spinner is a
/// continuous animation, so a settle would time out whenever a lookup is in
/// flight.
Future<void> _pumpDialog(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

/// The screen and the prompt deliberately offer the SAME GPS action, so a bare
/// label finder matches twice while the prompt is up. Scope to the modal.
Finder _inPrompt(String label) =>
    find.descendant(of: find.byType(AlertDialog), matching: find.text(label));

/// The Continue button in the docked bottom bar.
Finder get _continueButton => find.widgetWithText(ElevatedButton, 'Continue');

/// State ALWAYS precedes city (master spec), so the order is fixed.
Finder get _stateField => find.byType(OnboardingSelectField).at(0);
Finder get _cityField => find.byType(OnboardingSelectField).at(1);

String _valueOf(WidgetTester tester, Finder field) =>
    tester.widget<OnboardingSelectField>(field).value;

/// In an open picker sheet: search for [search], then tap the list row
/// [option] — or, with [custom], the "use what I typed" row.
Future<void> _pickInSheet(
  WidgetTester tester, {
  required String search,
  String? option,
  bool custom = false,
}) async {
  await tester.enterText(find.byKey(kOnboardingPickerSearchKey), search);
  await tester.pump();
  await tester.tap(
    custom
        ? find.byKey(kOnboardingPickerCustomKey)
        : find.widgetWithText(ListTile, option!),
  );
  await _pumpDialog(tester);
}

Future<void> _chooseState(WidgetTester tester, String state) async {
  await tester.tap(_stateField);
  await _pumpDialog(tester);
  expect(find.text(_kStateSheetTitle), findsOneWidget);
  await _pickInSheet(tester, search: state, option: state);
}

Future<void> _chooseCity(WidgetTester tester, String city) async {
  await tester.tap(_cityField);
  await _pumpDialog(tester);
  expect(find.text(_kCitySheetTitle), findsOneWidget);
  await _pickInSheet(tester, search: city, option: city);
}

/// Drives the app back to the foreground the way Android does, so the mid-form
/// permission-grant check (#1462 rule 2) actually runs.
Future<void> _resumeApp(WidgetTester tester) async {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  await _pumpDialog(tester);
}

Future<void> _enterName(WidgetTester tester) async {
  await tester.enterText(find.byType(TextField).at(0), 'Asha');
  await tester.enterText(find.byType(TextField).at(1), 'Kumari');
  await tester.pump();
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
    'renders separate first/last name fields, no single "poora naam" field',
    (WidgetTester tester) async {
      await _pump(
        tester,
        repo: MockNameRepository(),
        locationLookup: MockLocationLookup(),
      );

      // R17 — the spec's bilingual labels, so a worker who reads only one of
      // the two scripts' vocabularies still knows which box is which.
      expect(find.text('PEHLA NAAM (FIRST NAME)'), findsOneWidget);
      expect(find.text('AAKHRI NAAM (LAST NAME)'), findsOneWidget);
      // Exactly two typed fields — the name halves. Location is chosen through
      // the two pickers, which are always present.
      expect(find.byType(TextField), findsNWidgets(2));
      expect(find.byType(OnboardingSelectField), findsNWidgets(2));
    },
  );

  // #1462 rule 1 — the headline bug. The section used to render exactly ONE of
  // three states, so declining the permission swapped GPS out for the manual
  // boxes and there was no way back to it.
  testWidgets(
    'GPS and the manual pickers are BOTH on screen from the first frame',
    (WidgetTester tester) async {
      await _pump(
        tester,
        repo: MockNameRepository(),
        locationLookup: MockLocationLookup(),
      );

      expect(find.text('Location se bharein'), findsOneWidget);
      expect(find.text('STATE (RAJYA)'), findsOneWidget);
      expect(find.text('SHEHER (CITY)'), findsOneWidget);
      expect(
        find.text('Ya sheher aur state neeche khud chunein:'),
        findsOneWidget,
      );
      // State precedes city on screen, not just in the widget list.
      expect(
        tester.getTopLeft(find.text('STATE (RAJYA)')).dy,
        lessThan(tester.getTopLeft(find.text('SHEHER (CITY)')).dy),
      );
    },
  );

  testWidgets('the city picker stays disabled until a state is chosen', (
    WidgetTester tester,
  ) async {
    await _pump(
      tester,
      repo: MockNameRepository(),
      locationLookup: MockLocationLookup(),
    );

    expect(tester.widget<OnboardingSelectField>(_cityField).enabled, isFalse);
    await tester.tap(_cityField);
    await _pumpDialog(tester);
    expect(find.text(_kCitySheetTitle), findsNothing);

    await _chooseState(tester, 'Rajasthan');
    expect(tester.widget<OnboardingSelectField>(_cityField).enabled, isTrue);
  });

  testWidgets('changing the state to a different one clears the city', (
    WidgetTester tester,
  ) async {
    await _pump(
      tester,
      repo: MockNameRepository(),
      locationLookup: MockLocationLookup(),
    );

    await _chooseState(tester, 'Rajasthan');
    await _chooseCity(tester, 'Jaipur');
    expect(_valueOf(tester, _cityField), 'Jaipur');

    // Re-picking the SAME state keeps the city.
    await _chooseState(tester, 'Rajasthan');
    expect(_valueOf(tester, _cityField), 'Jaipur');

    await _chooseState(tester, 'Gujarat');
    expect(_valueOf(tester, _stateField), 'Gujarat');
    expect(_valueOf(tester, _cityField), isEmpty);
  });

  testWidgets(
    'a GPS failure never hides the GPS button — a later retry still works',
    (WidgetTester tester) async {
      final MockLocationLookup lookup = MockLocationLookup();
      when(() => lookup.resolveCurrent()).thenThrow(
        const LocationLookupFailure(
          LocationLookupFailureReason.permissionDenied,
        ),
      );
      await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

      await tester.tap(find.text('Location se bharein'));
      await tester.pump();
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(
        find.text('Location ki permission nahi mili. Neeche khud chunein.'),
        findsOneWidget,
      );
      // BOTH paths survive the failure: the button is still there AND still
      // enabled, and the manual pickers are untouched beside it.
      expect(find.text('Location se bharein'), findsOneWidget);
      expect(find.text('STATE (RAJYA)'), findsOneWidget);
      expect(find.text('SHEHER (CITY)'), findsOneWidget);
      expect(find.byType(OnboardingSelectField), findsNWidgets(2));

      // The worker grants the permission and taps again — the retry resolves.
      when(() => lookup.resolveCurrent()).thenAnswer(
        (_) async => const ResolvedLocation(city: 'Pune', state: 'Maharashtra'),
      );
      await tester.tap(find.text('Location se bharein'));
      await tester.pump();
      await tester.pump();

      expect(_valueOf(tester, _cityField), 'Pune');
      expect(_valueOf(tester, _stateField), 'Maharashtra');
    },
  );

  testWidgets(
    'a successful GPS resolve fills the two fields and submits what it found',
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

      // The result lands IN the changeable fields — one source of truth, and a
      // wrong reading stays correctable.
      expect(_valueOf(tester, _cityField), 'Pune');
      expect(_valueOf(tester, _stateField), 'Maharashtra');
      expect(
        find.text('Location mil gayi. Galat ho toh neeche badal sakte hain.'),
        findsOneWidget,
      );

      await _enterName(tester);
      await tester.tap(_continueButton);
      await tester.pump();

      verify(
        () =>
            repo.submitName('Asha Kumari', city: 'Pune', state: 'Maharashtra'),
      ).called(1);
    },
  );

  // #1428 — the manual path used to send ONE free-text `address` line, which
  // the API's zod object silently dropped (there is no address column), so a
  // hand-choosing worker's location was never stored at all. It now submits
  // the same city/state pair the GPS path does — and a city the list does not
  // carry is still accepted as typed, then title-cased.
  testWidgets(
    'manual entry submits the chosen state and typed city, title-cased',
    (WidgetTester tester) async {
      final MockNameRepository repo = MockNameRepository();
      await _pump(tester, repo: repo, locationLookup: MockLocationLookup());

      await _enterName(tester);
      await tester.tap(_stateField);
      await _pumpDialog(tester);
      await _pickInSheet(tester, search: 'rajasthan', option: 'Rajasthan');
      await tester.tap(_cityField);
      await _pumpDialog(tester);
      await _pickInSheet(tester, search: 'kotputli', custom: true);
      expect(_valueOf(tester, _cityField), 'kotputli');

      await tester.tap(_continueButton);
      await tester.pump();

      verify(
        () => repo.submitName(
          'Asha Kumari',
          city: 'Kotputli',
          state: 'Rajasthan',
        ),
      ).called(1);
    },
  );

  testWidgets('Continue stays disabled until the name is complete', (
    WidgetTester tester,
  ) async {
    await _pump(
      tester,
      repo: MockNameRepository(),
      locationLookup: MockLocationLookup(),
    );

    expect(tester.widget<ElevatedButton>(_continueButton).onPressed, isNull);

    await tester.enterText(find.byType(TextField).at(0), 'Asha');
    await tester.pump();
    // First name alone is not a name — both halves are required.
    expect(tester.widget<ElevatedButton>(_continueButton).onPressed, isNull);

    await tester.enterText(find.byType(TextField).at(1), 'Kumari');
    await tester.pump();
    expect(tester.widget<ElevatedButton>(_continueButton).onPressed, isNotNull);
  });

  // #1462 rule 3 — location no longer DISABLES Continue, because a disabled
  // button can never show the prompt that asks for the location.
  testWidgets('Continue with both fields empty asks for the location instead', (
    WidgetTester tester,
  ) async {
    final MockNameRepository repo = MockNameRepository();
    await _pump(tester, repo: repo, locationLookup: MockLocationLookup());

    await _enterName(tester);
    await tester.tap(_continueButton);
    await _pumpDialog(tester);

    expect(find.text(_kSubmitPromptTitle), findsOneWidget);
    expect(find.text(_kSkipLabel), findsOneWidget);
    verifyNever(
      () => repo.submitName(
        any(),
        city: any(named: 'city'),
        state: any(named: 'state'),
      ),
    );
  });

  testWidgets(
    'closing the submit-time prompt saves the name WITHOUT a location',
    (WidgetTester tester) async {
      final MockNameRepository repo = MockNameRepository();
      await _pump(tester, repo: repo, locationLookup: MockLocationLookup());

      await _enterName(tester);
      await tester.tap(_continueButton);
      await _pumpDialog(tester);
      await tester.tap(find.text(_kSkipLabel));
      await _pumpDialog(tester);

      // `city`/`state` are optional on SetMyNameSchema and the cubit sends null
      // for an empty field, so this is a valid call — the worker is never stuck.
      verify(
        () => repo.submitName('Asha Kumari', city: null, state: null),
      ).called(1);
    },
  );

  testWidgets('the prompt\'s GPS action resolves and fills the fields', (
    WidgetTester tester,
  ) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenAnswer(
      (_) async => const ResolvedLocation(city: 'Pune', state: 'Maharashtra'),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await _enterName(tester);
    await tester.tap(_continueButton);
    await _pumpDialog(tester);
    await tester.tap(_inPrompt('Location se bharein'));
    await _pumpDialog(tester);
    await tester.pump();

    expect(find.text(_kSubmitPromptTitle), findsNothing);
    expect(_valueOf(tester, _cityField), 'Pune');
  });

  testWidgets(
    'the prompt\'s manual action opens the State picker, then the City picker',
    (WidgetTester tester) async {
      await _pump(
        tester,
        repo: MockNameRepository(),
        locationLookup: MockLocationLookup(),
      );

      await _enterName(tester);
      await tester.tap(_continueButton);
      await _pumpDialog(tester);
      await tester.tap(_inPrompt('Khud chunein'));
      await _pumpDialog(tester);

      expect(find.text(_kSubmitPromptTitle), findsNothing);
      expect(find.text(_kStateSheetTitle), findsOneWidget);
      await _pickInSheet(tester, search: 'Maharashtra', option: 'Maharashtra');
      await _pumpDialog(tester);

      // The city sheet follows on its own — the worker is not left to find it.
      expect(find.text(_kCitySheetTitle), findsOneWidget);
      await _pickInSheet(tester, search: 'Pune', option: 'Pune');

      expect(_valueOf(tester, _stateField), 'Maharashtra');
      expect(_valueOf(tester, _cityField), 'Pune');
    },
  );

  testWidgets(
    'the prompt\'s manual action goes straight to the City picker when the '
    'state is already chosen',
    (WidgetTester tester) async {
      await _pump(
        tester,
        repo: MockNameRepository(),
        locationLookup: MockLocationLookup(),
      );

      await _enterName(tester);
      await _chooseState(tester, 'Rajasthan');
      await tester.tap(_continueButton);
      await _pumpDialog(tester);
      expect(find.text(_kSubmitPromptTitle), findsOneWidget);
      await tester.tap(_inPrompt('Khud chunein'));
      await _pumpDialog(tester);

      expect(find.text(_kStateSheetTitle), findsNothing);
      expect(find.text(_kCitySheetTitle), findsOneWidget);
    },
  );

  // #1462 rule 2 — declined the permission, carried on filling, then turned it
  // on from the shade. Coming back through `resumed` must offer GPS again.
  testWidgets('granting the permission mid-form offers GPS again on resume', (
    WidgetTester tester,
  ) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenThrow(
      const LocationLookupFailure(LocationLookupFailureReason.permissionDenied),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();
    expect(find.text(_kResumePromptTitle), findsNothing);

    when(() => lookup.isAvailable()).thenAnswer((_) async => true);
    await _resumeApp(tester);

    expect(find.text(_kResumePromptTitle), findsOneWidget);
    // The mid-form close is a plain dismiss — there is nothing to submit yet.
    expect(find.text('Band karein'), findsOneWidget);
    expect(find.text(_kSkipLabel), findsNothing);
  });

  testWidgets('the mid-form offer fires ONCE, not on every later resume', (
    WidgetTester tester,
  ) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenThrow(
      const LocationLookupFailure(LocationLookupFailureReason.serviceDisabled),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();

    when(() => lookup.isAvailable()).thenAnswer((_) async => true);
    await _resumeApp(tester);
    expect(find.text(_kResumePromptTitle), findsOneWidget);
    await tester.tap(find.text('Band karein'));
    await _pumpDialog(tester);

    await _resumeApp(tester);
    expect(find.text(_kResumePromptTitle), findsNothing);
  });

  testWidgets('no mid-form offer while the permission is still refused', (
    WidgetTester tester,
  ) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenThrow(
      const LocationLookupFailure(LocationLookupFailureReason.permissionDenied),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();
    await _resumeApp(tester);

    expect(find.text(_kResumePromptTitle), findsNothing);
  });

  testWidgets('no mid-form offer once the worker has chosen a location', (
    WidgetTester tester,
  ) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenThrow(
      const LocationLookupFailure(LocationLookupFailureReason.permissionDenied),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();
    await _chooseState(tester, 'Rajasthan');
    await _chooseCity(tester, 'Jaipur');

    when(() => lookup.isAvailable()).thenAnswer((_) async => true);
    await _resumeApp(tester);

    // Nothing is missing, so nothing interrupts.
    expect(find.text(_kResumePromptTitle), findsNothing);
  });

  // A dead geocoder or a timeout is not something a trip to Settings fixes,
  // so it must not arm the resume offer at all.
  testWidgets('an unresolvable fix does not arm the resume offer', (
    WidgetTester tester,
  ) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenThrow(
      const LocationLookupFailure(LocationLookupFailureReason.unresolved),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();

    when(() => lookup.isAvailable()).thenAnswer((_) async => true);
    await _resumeApp(tester);

    expect(find.text(_kResumePromptTitle), findsNothing);
    verifyNever(() => lookup.isAvailable());
  });

  // The floating Feedback button hides on /name because the bottom bar owns
  // this action — so the pill must actually reach the feedback page, and
  // report the route the worker was on.
  testWidgets('the Feedback pill opens the feedback page from /name', (
    WidgetTester tester,
  ) async {
    await _pump(
      tester,
      repo: MockNameRepository(),
      locationLookup: MockLocationLookup(),
    );

    await tester.tap(find.text('Feedback'));
    await _pumpDialog(tester);

    expect(find.text('$_kFeedbackMarker ${Routes.name}'), findsOneWidget);
  });

  // Every body must scroll: nothing may overflow on the smallest supported
  // phone or in landscape, even at 200% system font.
  for (final Size size in const <Size>[Size(320, 568), Size(844, 390)]) {
    testWidgets('no overflow at ${size.width.toInt()}x${size.height.toInt()} '
        'and 2.0 text scale', (WidgetTester tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await _pump(
        tester,
        repo: MockNameRepository(),
        locationLookup: MockLocationLookup(),
        size: size,
      );

      expect(tester.takeException(), isNull);
      expect(_continueButton, findsOneWidget);
      expect(find.text('Feedback'), findsOneWidget);

      // The submit-time prompt must fit too.
      await _enterName(tester);
      await tester.tap(_continueButton);
      await _pumpDialog(tester);
      expect(tester.takeException(), isNull);
      expect(find.text(_kSubmitPromptTitle), findsOneWidget);
    });
  }
}
