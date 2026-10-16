// The résumé-upload ENTRIES (the Résumé tab, "Mere resume", the Profile tab)
// through the REAL app router and locator over [MockApiClient]. Auth is not
// wired, so the redirect is inert and the production route table is what is
// under test (the same set-up as `router_resume_history_test.dart`).
//
// What only the real route table can prove:
//  * `ResumeUploadDirectIntent` reaches the screen as `directUpload`, the chat
//    prompt's `ResumeUploadAutoIntent` as `autoUpload`, and any other `extra`
//    as neither;
//  * each entry's push covers the shell, opens the picker by itself, falls
//    back to the doors on a cancel, and system back returns to where it came
//    from;
//  * a finished import lands on the Bada Bhai TAB (owner ruling 2026-10-16)
//    with NO import signal pending, while the chat prompt's marker still
//    lands on the onboarding chat and raises it;
//  * a double tap opens one upload screen and one picker (#1474).
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/resume_import_signal.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/profile_tab_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_history_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document_picker.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_upload_intent.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_screen.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/widgets/resume_door_tile.dart';
import 'package:badabhai_worker_app/router.dart';

/// Hands back whatever the test sets, and counts how often it was opened.
class _FakePicker implements ResumeDocumentPicker {
  ResumePickResult result = const ResumePickResult.rejected(
    ResumePickRejection.cancelled,
  );
  int calls = 0;

  @override
  Future<ResumePickResult> pickResume() async {
    calls++;
    return result;
  }
}

class _FakeImporter implements ResumeImporter {
  int calls = 0;

  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument d) async {
    calls++;
    return const ResumeImportRoutedToChat();
  }
}

/// Shell branch order (router.dart): Jobs 0 · Resume 1 · Bada Bhai 2 · Profile 3.
const int _kResumeTabIndex = 1;
const int _kChatTabIndex = 2;
const int _kProfileTabIndex = 3;

/// Advance the fake clock until [finder] matches (the mock client answers after
/// ~300ms; pumpAndSettle would hang on perpetual spinners).
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
  expect(
    finder,
    findsWidgets,
    reason: 'timed out (${maxFrames * 100}ms) waiting for $finder',
  );
}

Future<GoRouter> _pumpApp(WidgetTester tester) async {
  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final GoRouter router = buildAppRouter();
  await tester.pumpWidget(
    MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
  );
  await tester.pump();
  return router;
}

int _activeTab(WidgetTester tester) =>
    tester.widget<BbBottomNav>(find.byType(BbBottomNav)).currentIndex;

/// The route actually on top — `lastOrNull` descends into the shell's match,
/// the same read `pushOnce` makes (#1784).
String? _top(GoRouter router) =>
    router.routerDelegate.currentConfiguration.lastOrNull?.matchedLocation;

void main() {
  late _FakePicker picker;
  late _FakeImporter importer;

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    // A single document read, no retry timers: the Résumé tab must settle
    // inside this file's frame budget.
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
    // The two seams of the upload screen: the platform picker and the network
    // import. Everything else is the real graph.
    picker = _FakePicker();
    importer = _FakeImporter();
    await locator.unregister<ResumeDocumentPicker>();
    locator.registerLazySingleton<ResumeDocumentPicker>(() => picker);
    await locator.unregister<ResumeImporter>();
    locator.registerLazySingleton<ResumeImporter>(() => importer);
  });

  tearDown(() async {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
    await locator.reset();
  });

  testWidgets(
    'the real route table: each marker reaches the screen as its own flag, '
    'anything else as neither',
    (WidgetTester tester) async {
      final GoRouter router = await _pumpApp(tester);
      router.go(Routes.profile);
      await _pumpUntil(tester, find.byType(ProfileTabScreen));

      Future<ResumeUploadScreen> arrive(Object? extra) async {
        unawaited(router.push<void>(Routes.resumeUpload, extra: extra));
        await _pumpUntil(tester, find.byType(ResumeUploadScreen));
        final ResumeUploadScreen screen = tester.widget<ResumeUploadScreen>(
          find.byType(ResumeUploadScreen),
        );
        router.pop();
        await _pumpUntil(tester, find.byType(ProfileTabScreen));
        return screen;
      }

      final ResumeUploadScreen entry = await arrive(
        const ResumeUploadDirectIntent(),
      );
      expect(entry.directUpload, isTrue);
      expect(entry.autoUpload, isFalse,
          reason: 'an entry must never be read as the chat prompt');

      final ResumeUploadScreen prompt = await arrive(
        const ResumeUploadAutoIntent(),
      );
      expect(prompt.autoUpload, isTrue);
      expect(prompt.directUpload, isFalse);

      // The post-completion menu (no extra), a stray bool, a string: the doors,
      // exactly as before — a marker TYPE is the only way in.
      for (final Object? other in <Object?>[null, true, 'resume_upload']) {
        final ResumeUploadScreen doors = await arrive(other);
        expect(doors.autoUpload, isFalse, reason: 'extra: $other');
        expect(doors.directUpload, isFalse, reason: 'extra: $other');
      }
      // Two marker arrivals opened the picker; the three others did not.
      expect(picker.calls, 2);
    },
  );

  // Each entry, from the screen it lives on.
  final List<({String name, String location, Key key, Type home})> entries =
      <({String name, String location, Key key, Type home})>[
    (
      name: 'the Résumé tab',
      location: Routes.resume,
      key: kResumeTabUploadEntryKey,
      home: ResumePreviewScreen,
    ),
    (
      name: '"Mere resume"',
      location: Routes.resumeHistory,
      key: kResumeHistoryUploadEntryKey,
      home: ResumeHistoryScreen,
    ),
    (
      name: 'the Profile tab',
      location: Routes.profile,
      key: kProfileResumeUploadRowKey,
      home: ProfileTabScreen,
    ),
  ];

  for (final ({String name, String location, Key key, Type home}) e
      in entries) {
    testWidgets(
      '${e.name}: the picker opens over the shell, a cancel leaves the doors, '
      'and system back returns to ${e.name}',
      (WidgetTester tester) async {
        final GoRouter router = await _pumpApp(tester);
        router.go(e.location);
        await _pumpUntil(tester, find.byKey(e.key));

        await tester.ensureVisible(find.byKey(e.key));
        await tester.pump();
        await tester.tap(find.byKey(e.key));
        await _pumpUntil(tester, find.byType(ResumeDoorTile));

        expect(_top(router), Routes.resumeUpload);
        expect(picker.calls, 1, reason: 'opened without a second tap');
        expect(importer.calls, 0, reason: 'a cancel uploads nothing');
        expect(find.byType(ResumeDoorTile), findsNWidgets(2),
            reason: 'a cancel falls back to the doors — never a dead end');
        expect(find.byType(BbBottomNav), findsNothing,
            reason: 'full-screen over the shell, like every pushed task');

        // The Android back button.
        await tester.binding.handlePopRoute();
        await _pumpUntil(tester, find.byType(e.home));

        expect(find.byType(ResumeUploadScreen), findsNothing);
        expect(_top(router), e.location);
        expect(find.byType(BbBottomNav), findsOneWidget);
        expect(
          _activeTab(tester),
          e.location == Routes.resume ? _kResumeTabIndex : _kProfileTabIndex,
        );
      },
    );
  }

  testWidgets(
    'Résumé tab → entry → a finished import lands on the Bada Bhai TAB, with '
    'NO import signal left behind',
    (WidgetTester tester) async {
      picker.result = ResumePickResult.picked(
        PickedResumeDocument(
          kind: ResumeDocumentKind.pdf,
          bytes: Uint8List(1024),
        ),
      );
      final GoRouter router = await _pumpApp(tester);
      router.go(Routes.resume);
      await _pumpUntil(tester, find.byKey(kResumeTabUploadEntryKey));

      await tester.ensureVisible(find.byKey(kResumeTabUploadEntryKey));
      await tester.pump();
      await tester.tap(find.byKey(kResumeTabUploadEntryKey));
      await _pumpUntil(tester, find.byType(ChatProfilingScreen));

      expect(picker.calls, 1);
      expect(importer.calls, 1, reason: 'the import really ran');
      // Owner ruling 2026-10-16: the Bada Bhai TAB, inside the shell — never
      // the onboarding chat, which would reattach a finished session.
      expect(_top(router), Routes.badaBhai);
      expect(find.byType(BbBottomNav), findsOneWidget);
      expect(_activeTab(tester), _kChatTabIndex);
      expect(
        locator<ResumeImportSignal>().consume(),
        isFalse,
        reason: 'no chat prompt sent the worker here, so none is owed an answer',
      );
      // Let the mock chat's own opening settle before the tree is torn down.
      await tester.pump(const Duration(seconds: 2));
    },
  );

  // The control: the chat prompt's road, through the same production table,
  // still raises the signal its waiting prompt is owed. Without this row the
  // test above would also pass if NO arrival could raise the signal at all.
  testWidgets(
    'the chat prompt\'s marker, through the same table, still raises the '
    'signal its prompt is owed',
    (WidgetTester tester) async {
      picker.result = ResumePickResult.picked(
        PickedResumeDocument(
          kind: ResumeDocumentKind.pdf,
          bytes: Uint8List(1024),
        ),
      );
      final GoRouter router = await _pumpApp(tester);
      router.go(Routes.profile);
      await _pumpUntil(tester, find.byType(ProfileTabScreen));

      unawaited(
        router.push<void>(
          Routes.resumeUpload,
          extra: const ResumeUploadAutoIntent(),
        ),
      );
      await _pumpUntil(tester, find.byType(ChatProfilingScreen));

      expect(importer.calls, 1);
      expect(_top(router), Routes.chatProfiling);
      expect(locator<ResumeImportSignal>().consume(), isTrue);
      await tester.pump(const Duration(seconds: 2));
    },
  );

  // #1474 — a worker on a cheap phone taps twice when a screen does not appear
  // at once. `pushOnce` is the only thing standing between that and two upload
  // screens with two pickers: neither BbButton nor BbListRow debounces.
  for (final ({String name, String location, Key key}) e
      in <({String name, String location, Key key})>[
    (
      name: 'the Résumé tab button',
      location: Routes.resume,
      key: kResumeTabUploadEntryKey,
    ),
    (
      name: 'the Profile tab row',
      location: Routes.profile,
      key: kProfileResumeUploadRowKey,
    ),
  ]) {
    testWidgets('a double tap on ${e.name} opens ONE upload screen and ONE '
        'picker', (WidgetTester tester) async {
      final GoRouter router = await _pumpApp(tester);
      router.go(e.location);
      await _pumpUntil(tester, find.byKey(e.key));
      await tester.ensureVisible(find.byKey(e.key));
      await tester.pump();

      // Two taps inside one frame.
      await tester.tap(find.byKey(e.key));
      await tester.tap(find.byKey(e.key), warnIfMissed: false);
      await _pumpUntil(tester, find.byType(ResumeDoorTile));

      expect(
        find.byType(ResumeUploadScreen, skipOffstage: false),
        findsOneWidget,
      );
      expect(picker.calls, 1);
      expect(
        router.routerDelegate.currentConfiguration.matches.length,
        2,
        reason: 'the tab and one upload screen over it, not two',
      );
    });
  }
}
