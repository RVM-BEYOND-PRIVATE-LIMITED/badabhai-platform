// An upload ENTRY on a tab is not an onboarding step.
//
// `Routes.resumeUpload` sits in the router's onboarding set so that a worker
// killed on it MID-REGISTRATION comes back to it on the next cold start
// (#1470). A finished worker who opens it from the Résumé tab, "Mere resume"
// or the Profile tab is not registering. If that push were remembered, backing
// out of it would not undo it — a back pop runs no redirect — and the next cold
// start would unlock onto the onboarding two-door screen: no shell, no back
// arrow, and both doors leading into the onboarding chat.
//
// Driven through the REAL router redirect with persistent auth on, the same
// wiring `auth_routing_test.dart` uses.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/app.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document_picker.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_upload_intent.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_screen.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/widgets/resume_door_tile.dart';
import 'package:badabhai_worker_app/router.dart';

import '../../core/auth/fakes.dart';

/// A worker who opens the picker and backs out of it.
class _CancellingPicker implements ResumeDocumentPicker {
  int calls = 0;

  @override
  Future<ResumePickResult> pickResume() async {
    calls++;
    return const ResumePickResult.rejected(ResumePickRejection.cancelled);
  }
}

/// A worker who picks a PDF.
class _PickingPicker implements ResumeDocumentPicker {
  @override
  Future<ResumePickResult> pickResume() async => ResumePickResult.picked(
        PickedResumeDocument(
          kind: ResumeDocumentKind.pdf,
          bytes: Uint8List(1024),
        ),
      );
}

/// An import that reads cleanly and hands over to the chat.
class _ChatRoutedImporter implements ResumeImporter {
  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument d) async =>
      const ResumeImportRoutedToChat();
}

/// Never reached on a cancel; registered so the screen's cubit can be built.
class _UnusedImporter implements ResumeImporter {
  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument d) =>
      throw StateError('a cancelled pick must import nothing');
}

Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  int maxFrames = 50,
}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      await tester.pump(const Duration(milliseconds: 400));
      return;
    }
  }
  expect(finder, findsWidgets, reason: 'timed out waiting for $finder');
}

Future<void> _enterPin(WidgetTester tester, String pin) async {
  for (final String d in pin.split('')) {
    await tester.tap(
      find.descendant(of: find.byType(BbPinKeypad), matching: find.text(d)),
    );
    await tester.pump();
  }
}

void main() {
  late _CancellingPicker picker;

  // The unlock row's caret blinks forever; freeze it (see auth_routing_test).
  setUpAll(() => BbPinView.debugDeterministicCaret = true);
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  setUp(() {
    // One document read and no retry timer: the Résumé tab must settle inside
    // this file's frame budget.
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;
  });

  tearDown(() async {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
    await locator.reset();
  });

  /// A returning, FINISHED worker's device: tokens and a PIN, no onboarding
  /// step. [backing] is the secure store's map, shared across a "restart".
  Future<void> wire(Map<String, String> backing, {bool seed = true}) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(
      apiClient: MockApiClient(),
      secureStore: FakeSecureStore(backing),
    );
    final SecureTokenStore store = locator<SecureTokenStore>();
    if (seed) {
      await store.writeRefreshToken('remembered-refresh');
      await store.writeWorkerId('worker-7');
      await store.writePinSet(true);
    }
    picker = _CancellingPicker();
    await locator.unregister<ResumeDocumentPicker>();
    locator.registerLazySingleton<ResumeDocumentPicker>(() => picker);
    await locator.unregister<ResumeImporter>();
    locator.registerLazySingleton<ResumeImporter>(_UnusedImporter.new);
    await initAuthLocator(
      localeStore: LocaleStore(FakePrefs()),
      authApi: MockAuthApi(store),
      persistentAuthEnabled: true,
    );
    await locator<AuthSessionManager>().bootstrap();
  }

  Future<GoRouter> unlockToShell(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));
    await _enterPin(tester, '7416'); // any 4 digits — the mock accepts
    await _pumpUntil(tester, find.byKey(kResumeTabUploadEntryKey));
    return GoRouter.of(tester.element(find.byType(ResumePreviewScreen)));
  }

  /// Résumé tab → "Resume upload karein" → the picker (cancelled) → the doors
  /// → the Android back button → the tab again.
  Future<void> openTheEntryAndBackOut(WidgetTester tester) async {
    await tester.ensureVisible(find.byKey(kResumeTabUploadEntryKey));
    await tester.pump();
    await tester.tap(find.byKey(kResumeTabUploadEntryKey));
    await _pumpUntil(tester, find.byType(ResumeDoorTile));
    expect(picker.calls, 1, reason: 'precondition: the entry opened the picker');

    await tester.binding.handlePopRoute();
    await _pumpUntil(tester, find.byType(ResumePreviewScreen));
    expect(find.byType(ResumeUploadScreen), findsNothing);
  }

  /// Lets the Résumé tab's own mock reads finish before the tree goes away.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 700));
    await tester.pump(const Duration(milliseconds: 700));
  }

  testWidgets('a finished worker who opens an entry and backs out has no '
      'onboarding step to come back to', (WidgetTester tester) async {
    final Map<String, String> backing = <String, String>{};
    await wire(backing);
    await unlockToShell(tester);
    final AuthSessionManager auth = locator<AuthSessionManager>();
    expect(auth.onboardingLocation, isNull,
        reason: 'precondition: a finished worker has no step');

    await openTheEntryAndBackOut(tester);

    expect(auth.onboardingLocation, isNull,
        reason: 'an upload entry is not a registration step');
    expect(
      await locator<SecureTokenStore>().readOnboardingLocation(),
      isNull,
      reason: 'nothing is persisted for the next cold start to land on',
    );
    await settle(tester);
  });

  testWidgets('…so the next cold start unlocks onto the shell, not the '
      'onboarding doors', (WidgetTester tester) async {
    final Map<String, String> backing = <String, String>{};
    await wire(backing);
    await unlockToShell(tester);
    await openTheEntryAndBackOut(tester);
    await settle(tester);

    // The worker closes the app. A cold start: a new app over the SAME
    // secure store, bootstrapped from what was persisted.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
    await wire(backing, seed: false);
    await unlockToShell(tester);

    expect(find.byType(ResumePreviewScreen), findsOneWidget);
    expect(find.byType(ResumeUploadScreen), findsNothing,
        reason: 'the doors are an onboarding step, never a finished worker\'s '
            'landing');
    await settle(tester);
  });

  // The SUCCESS path: a finished import leaves the upload screen with a `go`
  // into the chat, and the landing must not become a registration step either.
  testWidgets('a finished worker whose entry import FINISHES has no onboarding '
      'step either', (WidgetTester tester) async {
    await wire(<String, String>{});
    await locator.unregister<ResumeDocumentPicker>();
    locator.registerLazySingleton<ResumeDocumentPicker>(_PickingPicker.new);
    await locator.unregister<ResumeImporter>();
    locator.registerLazySingleton<ResumeImporter>(_ChatRoutedImporter.new);
    await unlockToShell(tester);
    final AuthSessionManager auth = locator<AuthSessionManager>();

    await tester.ensureVisible(find.byKey(kResumeTabUploadEntryKey));
    await tester.pump();
    await tester.tap(find.byKey(kResumeTabUploadEntryKey));
    // The picker opens by itself, the import finishes and the screen leaves.
    for (int i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }

    expect(find.byType(ResumeUploadScreen), findsNothing,
        reason: 'precondition: the import finished and the screen left');
    expect(auth.onboardingLocation, isNull,
        reason: 'a finished worker is not registering, wherever the import '
            'hands over to');
    await settle(tester);
  });

  // The rule's other half — what it must still PERMIT. The chat prompt's
  // arrival is a real registration step (the worker is mid-onboarding in the
  // chat), and being killed on it must still bring them back to it (#1470).
  testWidgets('the chat prompt\'s arrival IS still remembered — the durable '
      'step #1470 keeps', (WidgetTester tester) async {
    await wire(<String, String>{});
    final GoRouter router = await unlockToShell(tester);

    unawaited(
      router.push<void>(
        Routes.resumeUpload,
        extra: const ResumeUploadAutoIntent(),
      ),
    );
    await _pumpUntil(tester, find.byType(ResumeDoorTile));

    expect(
      locator<AuthSessionManager>().onboardingLocation,
      Routes.resumeUpload,
    );
    await settle(tester);
  });
}
