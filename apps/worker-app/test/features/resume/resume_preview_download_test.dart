import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/util/pdf_downloader.dart';
import 'package:badabhai_worker_app/core/util/resume_file_name.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

/// The FULL in-app download journey on the REAL screen: tap → busy button +
/// "shuru ho gaya" notice on the SAME screen → save crosses the platform
/// channel with the DERIVED file name (FIRSTNAME_..._RESUME.pdf, from the
/// worker's own name) → "complete" notice → "Kholein" opens the SAVED LOCAL
/// file. The repo resolves the `mock://` sentinel, so no byte fetch happens
/// (exactly the offline mock-mode walk).
void main() {
  const MethodChannel channel = MethodChannel('badabhai.workerapp/downloads');

  late MockResumeRepository repo;
  late MockResumeEditRepository editRepo;
  late List<MethodCall> channelCalls;

  Future<void> pumpScreen(
    WidgetTester tester, {
    String? name,
    bool throwOnLoad = false,
  }) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    repo = MockResumeRepository();
    editRepo = MockResumeEditRepository();
    if (throwOnLoad) {
      when(() => editRepo.load()).thenThrow(const UnauthorizedFailure());
    } else {
      when(() => editRepo.load()).thenAnswer(
        (_) async => ResumeSafeFields(
          displayName: name ?? '',
          showPhoto: false,
          nightShiftReady: false,
        ),
      );
    }
    locator.registerFactory<ResumeCubit>(() => ResumeCubit(repo));
    // The screen refetches on tab focus (T4) and resolves this from the locator.
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
    locator.registerFactory<ResumeEditRepository>(() => editRepo);

    channelCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (MethodCall call) async {
      channelCalls.add(call);
      if (call.method == 'saveToDownloads') {
        final Map<dynamic, dynamic> args = call.arguments as Map<dynamic, dynamic>;
        return <String, Object>{
          'location': 'content://downloads/7',
          'displayName': args['fileName'] as String,
          'public': true,
        };
      }
      if (call.method == 'openSavedFile') return true;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const ResumePreviewScreen(initialResume: 'MOCK RESUME BODY'),
    ));
    await tester.pump();
    // Let the download button's name PREFETCH (initState → editRepo.load())
    // resolve and re-render before the test taps, so `_fileName` is the derived
    // name rather than the still-pending fallback.
    await tester.pump();
  }

  tearDown(() async => locator.reset());

  testWidgets(
      'download stays on-screen: busy state, started + complete notices, '
      'DERIVED file name over the channel, Kholein opens the saved file',
      (WidgetTester tester) async {
    await pumpScreen(tester, name: 'Ramesh Kumar');
    // Gate the url resolve so the busy state is deterministically observable.
    final Completer<String> urlGate = Completer<String>();
    when(() => repo.resumeDownloadUrl()).thenAnswer((_) => urlGate.future);

    await tester.tap(find.text('Download Resume'));
    await tester.pump();

    // Still on the resume screen (no navigation), started notice + busy CTA.
    expect(find.text('MOCK RESUME BODY'), findsOneWidget);
    expect(find.text(kDownloadStartedNotice), findsOneWidget);
    expect(
      tester
          .widget<BbButton>(find.widgetWithText(BbButton, 'Download Resume'))
          .loading,
      isTrue,
    );

    // A second tap while busy is inert (BbButton disables onPressed) — no
    // double download, no double file.
    await tester.tap(find.text('Download Resume'), warnIfMissed: false);
    await tester.pump();

    urlGate.complete('mock://downloads/resume/mock-resume-0001.pdf');
    await tester.pump();
    await tester.pump();

    expect(find.text(kDownloadCompleteNotice), findsOneWidget);
    verify(() => repo.resumeDownloadUrl()).called(1);

    final MethodCall save =
        channelCalls.singleWhere((MethodCall c) => c.method == 'saveToDownloads');
    final Map<dynamic, dynamic> saveArgs = save.arguments as Map<dynamic, dynamic>;
    // The saved file is named from the worker's OWN name (all-words format).
    expect(saveArgs['fileName'], 'RAMESH_KUMAR_RESUME.pdf');
    // The cache temp file handed to the platform was cleaned up afterwards.
    expect(File(saveArgs['tempPath'] as String).existsSync(), isFalse);

    // Button is usable again once the download finished.
    expect(
      tester
          .widget<BbButton>(find.widgetWithText(BbButton, 'Download Resume'))
          .loading,
      isFalse,
    );

    // Let the SnackBar's entrance animation finish (it ignores pointers while
    // animating in), then "Kholein" opens the SAVED LOCAL file via the channel.
    await tester.pumpAndSettle();
    await tester.tap(find.text(kDownloadOpenActionLabel));
    await tester.pump();
    final MethodCall open =
        channelCalls.singleWhere((MethodCall c) => c.method == 'openSavedFile');
    expect((open.arguments as Map<dynamic, dynamic>)['location'],
        'content://downloads/7');
  });

  testWidgets(
      'a failed name prefetch falls back to the generic file name — the '
      'download itself is never blocked', (WidgetTester tester) async {
    await pumpScreen(tester, throwOnLoad: true);
    when(() => repo.resumeDownloadUrl())
        .thenAnswer((_) async => 'mock://downloads/resume/mock-resume-0001.pdf');

    await tester.tap(find.text('Download Resume'));
    await tester.pump();
    await tester.pump();

    expect(find.text(kDownloadCompleteNotice), findsOneWidget);
    final MethodCall save =
        channelCalls.singleWhere((MethodCall c) => c.method == 'saveToDownloads');
    final Map<dynamic, dynamic> saveArgs = save.arguments as Map<dynamic, dynamic>;
    expect(saveArgs['fileName'], kFallbackResumeFileName);
  });
}
