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
const String _kResumeUploadMarker = 'RESUME_UPLOAD_SCREEN_MARKER';

/// Copy the prompt shows in each of its two roles (#1462).
const String _kSubmitPromptTitle = 'Location reh gayi';
const String _kResumePromptTitle = 'Location ab mil sakti hai';
const String _kSkipLabel = 'Bina location aage badhein';

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
      state: any(named: 'state'))).thenAnswer((_) async {});
  // Default: GPS is NOT silently available, so the resume check never fires
  // unless a test opts in. Tests that never touch it still need the stub —
  // an unstubbed mocktail call would throw inside the lifecycle callback.
  when(() => locationLookup.isAvailable()).thenAnswer((_) async => false);
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
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
  );
  await tester.pump();
}

/// Two frames — one for the state change, one for the dialog route to open.
/// Deliberately NOT `pumpAndSettle`: the GPS button's spinner is a continuous
/// animation, so a settle would time out whenever a lookup is in flight.
Future<void> _pumpDialog(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

/// The screen and the prompt deliberately offer the SAME two actions, so a
/// bare label finder matches twice while the prompt is up. Scope to the modal.
Finder _inPrompt(String label) => find.descendant(
      of: find.byType(AlertDialog),
      matching: find.widgetWithText(FilledButton, label),
    );

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
    await _pump(tester, repo: MockNameRepository(), locationLookup: MockLocationLookup());

    expect(find.text('PEHLA NAAM'), findsOneWidget);
    expect(find.text('AAKHRI NAAM'), findsOneWidget);
    // Two name fields + the two location boxes, which are now always present.
    expect(find.byType(TextField), findsNWidgets(4));
  });

  // #1462 rule 1 — the headline bug. The section used to render exactly ONE of
  // three states, so declining the permission swapped GPS out for the manual
  // boxes and there was no way back to it.
  testWidgets('GPS and the manual boxes are BOTH on screen from the first frame',
      (WidgetTester tester) async {
    await _pump(tester, repo: MockNameRepository(), locationLookup: MockLocationLookup());

    expect(find.text('Location se bharein'), findsOneWidget);
    expect(find.text('SHEHER'), findsOneWidget);
    expect(find.text('STATE'), findsOneWidget);
  });

  testWidgets(
      'a GPS failure never hides the GPS button — a later retry still works',
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
    // BOTH paths survive the failure: the button is still there AND still
    // enabled, and the manual boxes are untouched beside it.
    expect(find.text('Location se bharein'), findsOneWidget);
    expect(find.text('SHEHER'), findsOneWidget);
    expect(find.text('STATE'), findsOneWidget);
    expect(find.byType(TextField), findsNWidgets(4));

    // The worker grants the permission and taps again — the retry resolves.
    when(() => lookup.resolveCurrent()).thenAnswer(
      (_) async => const ResolvedLocation(city: 'Pune', state: 'Maharashtra'),
    );
    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();

    expect(
        tester.widget<TextField>(find.byType(TextField).at(2)).controller!.text,
        'Pune');
    expect(
        tester.widget<TextField>(find.byType(TextField).at(3)).controller!.text,
        'Maharashtra');
  });

  testWidgets(
      'a successful GPS resolve fills the two boxes and submits what it found',
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

    // The result lands IN the editable boxes — one source of truth, and a
    // wrong reading stays correctable.
    expect(
        tester.widget<TextField>(find.byType(TextField).at(2)).controller!.text,
        'Pune');
    expect(
        tester.widget<TextField>(find.byType(TextField).at(3)).controller!.text,
        'Maharashtra');
    expect(find.text('Location mil gayi. Galat ho toh neeche badal sakte hain.'),
        findsOneWidget);

    await _enterName(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();

    verify(() => repo.submitName('Asha Kumari',
            city: 'Pune', state: 'Maharashtra'))
        .called(1);
  });

  // #1428 — the manual path used to send ONE free-text `address` line, which
  // the API's zod object silently dropped (there is no address column), so a
  // hand-typing worker's location was never stored at all. It now submits the
  // same city/state pair the GPS path does.
  testWidgets('manual entry submits the typed city/state, title-cased',
      (WidgetTester tester) async {
    final MockNameRepository repo = MockNameRepository();
    await _pump(tester, repo: repo, locationLookup: MockLocationLookup());

    await _enterName(tester);
    await tester.enterText(find.byType(TextField).at(2), 'jaipur');
    await tester.enterText(find.byType(TextField).at(3), 'rajasthan');
    await tester.pump();

    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await tester.pump();

    verify(() => repo.submitName('Asha Kumari',
            city: 'Jaipur', state: 'Rajasthan'))
        .called(1);
  });

  testWidgets('Continue stays disabled until the name is complete',
      (WidgetTester tester) async {
    await _pump(tester, repo: MockNameRepository(), locationLookup: MockLocationLookup());

    final Finder continueButton = find.widgetWithText(FilledButton, 'Continue');
    expect(tester.widget<FilledButton>(continueButton).onPressed, isNull);

    await tester.enterText(find.byType(TextField).at(0), 'Asha');
    await tester.pump();
    // First name alone is not a name — both halves are required.
    expect(tester.widget<FilledButton>(continueButton).onPressed, isNull);

    await tester.enterText(find.byType(TextField).at(1), 'Kumari');
    await tester.pump();
    expect(tester.widget<FilledButton>(continueButton).onPressed, isNotNull);
  });

  // #1462 rule 3 — location no longer DISABLES Continue, because a disabled
  // button can never show the prompt that asks for the location.
  testWidgets('Continue with both boxes empty asks for the location instead',
      (WidgetTester tester) async {
    final MockNameRepository repo = MockNameRepository();
    await _pump(tester, repo: repo, locationLookup: MockLocationLookup());

    await _enterName(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await _pumpDialog(tester);

    expect(find.text(_kSubmitPromptTitle), findsOneWidget);
    expect(find.text(_kSkipLabel), findsOneWidget);
    verifyNever(() => repo.submitName(any(),
        city: any(named: 'city'), state: any(named: 'state')));
  });

  testWidgets(
      'closing the submit-time prompt saves the name WITHOUT a location',
      (WidgetTester tester) async {
    final MockNameRepository repo = MockNameRepository();
    await _pump(tester, repo: repo, locationLookup: MockLocationLookup());

    await _enterName(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await _pumpDialog(tester);
    await tester.tap(find.text(_kSkipLabel));
    await _pumpDialog(tester);

    // `city`/`state` are optional on SetMyNameSchema and the cubit sends null
    // for an empty box, so this is a valid call — the worker is never stuck.
    verify(() => repo.submitName('Asha Kumari', city: null, state: null))
        .called(1);
  });

  testWidgets('the prompt\'s GPS action resolves and fills the boxes',
      (WidgetTester tester) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenAnswer(
      (_) async => const ResolvedLocation(city: 'Pune', state: 'Maharashtra'),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await _enterName(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await _pumpDialog(tester);
    await tester.tap(_inPrompt('Location se bharein'));
    await _pumpDialog(tester);
    await tester.pump();

    expect(find.text(_kSubmitPromptTitle), findsNothing);
    expect(
        tester.widget<TextField>(find.byType(TextField).at(2)).controller!.text,
        'Pune');
  });

  testWidgets('the prompt\'s manual action closes onto the city box',
      (WidgetTester tester) async {
    await _pump(tester, repo: MockNameRepository(), locationLookup: MockLocationLookup());

    await _enterName(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Continue'));
    await _pumpDialog(tester);
    await tester.tap(_inPrompt('Khud likhein'));
    await _pumpDialog(tester);

    expect(find.text(_kSubmitPromptTitle), findsNothing);
    expect(tester.widget<TextField>(find.byType(TextField).at(2)).focusNode!.hasFocus,
        isTrue);
  });

  // #1462 rule 2 — declined the permission, carried on typing, then turned it
  // on from the shade. Coming back through `resumed` must offer GPS again.
  testWidgets('granting the permission mid-form offers GPS again on resume',
      (WidgetTester tester) async {
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

  testWidgets('the mid-form offer fires ONCE, not on every later resume',
      (WidgetTester tester) async {
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

  testWidgets('no mid-form offer while the permission is still refused',
      (WidgetTester tester) async {
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

  testWidgets('no mid-form offer once the worker has typed a location',
      (WidgetTester tester) async {
    final MockLocationLookup lookup = MockLocationLookup();
    when(() => lookup.resolveCurrent()).thenThrow(
      const LocationLookupFailure(LocationLookupFailureReason.permissionDenied),
    );
    await _pump(tester, repo: MockNameRepository(), locationLookup: lookup);

    await tester.tap(find.text('Location se bharein'));
    await tester.pump();
    await tester.pump();
    await tester.enterText(find.byType(TextField).at(2), 'Jaipur');
    await tester.enterText(find.byType(TextField).at(3), 'Rajasthan');
    await tester.pump();

    when(() => lookup.isAvailable()).thenAnswer((_) async => true);
    await _resumeApp(tester);

    // Nothing is missing, so nothing interrupts.
    expect(find.text(_kResumePromptTitle), findsNothing);
  });

  // A dead geocoder or a timeout is not something a trip to Settings fixes,
  // so it must not arm the resume offer at all.
  testWidgets('an unresolvable fix does not arm the resume offer',
      (WidgetTester tester) async {
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
}
