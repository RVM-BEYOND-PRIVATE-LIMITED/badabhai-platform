import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/resume_import_signal.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document_picker.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class _FakePicker implements ResumeDocumentPicker {
  @override
  Future<ResumePickResult> pickResume() async => ResumePickResult.picked(
        PickedResumeDocument(
          kind: ResumeDocumentKind.pdf,
          bytes: Uint8List(1024),
        ),
      );
}

class _FakeImporter implements ResumeImporter {
  _FakeImporter(this.outcome);
  final ResumeImportOutcome outcome;
  int calls = 0;
  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument d) async {
    calls++;
    return outcome;
  }
}

/// ── THE CUBIT RAISES THE SIGNAL ON *EVERY* COMPLETED ATTEMPT ───────────────
///
/// This is the link that broke twice. The chat's release used to hang off the
/// route extra, which the cubit sets from `cameFromImport` — FALSE on an import
/// that learned nothing and on uploads-unavailable. On those branches the chat
/// was never told, so it re-asked the résumé prompt over a résumé the worker
/// had just uploaded.
///
/// The signal says only "the worker walked through the upload door", which is
/// true of every one of them.
void main() {
  late _FakeImporter importer;
  late GoRouter router;

  Future<void> pumpUpload(
    WidgetTester tester,
    ResumeImportOutcome outcome, {
    bool autoUpload = true,
    bool directUpload = false,
    bool chatMenuUpload = false,
  }) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    importer = _FakeImporter(outcome);
    locator.registerLazySingleton<ResumeDocumentPicker>(() => _FakePicker());
    locator.registerLazySingleton<ResumeImporter>(() => importer);
    locator.registerLazySingleton<ResumeImportSignal>(
      () => ResumeImportSignal(),
    );
    addTearDown(locator.reset);

    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    router = GoRouter(
      initialLocation: Routes.resumeUpload,
      routes: <RouteBase>[
        GoRoute(
          path: Routes.resumeUpload,
          builder: (_, __) => ResumeUploadScreen(
            autoUpload: autoUpload,
            directUpload: directUpload,
            chatMenuUpload: chatMenuUpload,
          ),
        ),
        GoRoute(
          path: Routes.chatProfiling,
          builder: (_, __) => const Scaffold(body: Text('CHAT')),
        ),
        GoRoute(
          path: Routes.tradeForm,
          builder: (_, __) => const Scaffold(body: Text('FORM')),
        ),
        GoRoute(
          path: Routes.badaBhai,
          builder: (_, __) => const Scaffold(body: Text('BADA BHAI TAB')),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
    );
    await tester.pumpAndSettle();
  }

  final Map<String, ResumeImportOutcome> outcomes =
      <String, ResumeImportOutcome>{
    'routed to chat (learned something)': const ResumeImportRoutedToChat(),
    // `cameFromImport` is FALSE here — the branch the device hit.
    'routed to chat, learned NOTHING': const ResumeImportRoutedToChat(
      learnedNothing: true,
    ),
    'routed to the form': const ResumeImportRoutedToForm(),
    // `cameFromImport` is FALSE here too.
    'uploads unavailable': const ResumeImportUnavailable(),
  };

  outcomes.forEach((String name, ResumeImportOutcome outcome) {
    testWidgets('the signal is raised — $name', (WidgetTester tester) async {
      await pumpUpload(tester, outcome);
      expect(
        locator<ResumeImportSignal>().consume(),
        isTrue,
        reason: 'the worker walked through the upload door on this outcome too',
      );
    });
  });

  testWidgets('NOT raised when no chat prompt sent the worker here',
      (WidgetTester tester) async {
    // The post-completion résumé menu and a deep link draw the two DOORS
    // (`autoUpload` false). No prompt is standing open in the chat, so there is
    // nothing to answer — and raising here would spend the signal on a prompt
    // the worker has not been shown yet.
    await pumpUpload(tester, const ResumeImportRoutedToChat(),
        autoUpload: false);
    await tester.tap(find.text('Resume upload karein'));
    await tester.pumpAndSettle();

    expect(locator<ResumeImportSignal>().consume(), isFalse);
  });

  // ── AN UPLOAD ENTRY OUTSIDE THE CHAT RAISES NOTHING ────────────────────────
  //
  // The Résumé tab, "Mere resume" and the Profile tab open this screen with
  // `directUpload`: the picker opens on entry, exactly as for the chat prompt,
  // but NO prompt is standing open behind it. A signal raised here would sit
  // unconsumed until the next time the chat put the résumé prompt on screen —
  // and answer THAT prompt with an upload the worker made somewhere else.
  //
  // Every outcome, for the same reason the raise above is pinned on every
  // outcome: the import's result is not what decides it, the arrival is.
  outcomes.forEach((String name, ResumeImportOutcome outcome) {
    testWidgets('a direct arrival never raises the signal — $name',
        (WidgetTester tester) async {
      await pumpUpload(
        tester,
        outcome,
        autoUpload: false,
        directUpload: true,
      );

      // Vacuity guard: the attempt really ran to completion. Without it, a
      // direct arrival that never opened the picker would pass for free.
      expect(importer.calls, 1, reason: 'the picker opened and the import ran');
      // An entry's attempt ends on the Bada Bhai tab (owner ruling 2026-10-16).
      expect(
        router.routerDelegate.currentConfiguration.matches.last.matchedLocation,
        Routes.badaBhai,
      );
      expect(
        locator<ResumeImportSignal>().consume(),
        isFalse,
        reason: 'no chat prompt sent the worker here, so none is owed an answer',
      );
    });
  });

  // ── THE BADA BHAI MENU RAISES NOTHING EITHER ───────────────────────────────
  //
  // The post-completion menu's "Resume upload karein" is not the name-intake
  // prompt: it is a navigation chip in an ENDED session. Raising the signal
  // here would sit until a later prompt and answer it for the worker.
  outcomes.forEach((String name, ResumeImportOutcome outcome) {
    testWidgets('a chat-menu arrival never raises the signal — $name',
        (WidgetTester tester) async {
      await pumpUpload(
        tester,
        outcome,
        autoUpload: false,
        chatMenuUpload: true,
      );

      expect(importer.calls, 1, reason: 'the picker opened and the import ran');
      expect(locator<ResumeImportSignal>().consume(), isFalse,
          reason: 'the menu is not the résumé prompt');
    });
  });
}
