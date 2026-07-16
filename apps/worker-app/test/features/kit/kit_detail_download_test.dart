import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/util/pdf_downloader.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit_repository.dart';
import 'package:badabhai_worker_app/features/kit/presentation/cubit/kit_detail_cubit.dart';
import 'package:badabhai_worker_app/features/kit/presentation/kit_detail_screen.dart';

class MockInterviewKitRepository extends Mock
    implements InterviewKitRepository {}

const InterviewKit _kit = InterviewKit(
  tradeKey: 'cnc_operator',
  title: 'CNC Operator',
  overview: 'Prep pack.',
  commonQuestions: <String>['Kaun si machine chalayi hai?'],
  practicalQuestions: <String>[],
  safetyQuestions: <String>[],
  drawingMeasurementQuestions: <String>[],
  skillChecklist: <String>[],
  reviseBefore: <String>[],
  documentsToCarry: <String>[],
  commonMistakes: <String>[],
  hinglishNote: '',
);

/// The kit's AppBar download action runs the same in-app flow: spinner while
/// downloading (double-tap-proof), per-trade file name over the channel,
/// complete notice — all without leaving the detail screen.
void main() {
  const MethodChannel channel = MethodChannel('badabhai.workerapp/downloads');

  late MockInterviewKitRepository repo;
  late List<MethodCall> channelCalls;

  Future<void> pumpScreen(WidgetTester tester) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    repo = MockInterviewKitRepository();
    when(() => repo.kit(any())).thenAnswer((_) async => _kit);
    locator.registerFactory<KitDetailCubit>(() => KitDetailCubit(repo));

    channelCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (MethodCall call) async {
      channelCalls.add(call);
      if (call.method == 'saveToDownloads') {
        final Map<dynamic, dynamic> args = call.arguments as Map<dynamic, dynamic>;
        return <String, Object>{
          'location': 'content://downloads/9',
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
      home: const KitDetailScreen(tradeKey: 'cnc_operator'),
    ));
    await tester.pump(); // loading
    await tester.pump(); // kit() resolves -> ready
  }

  tearDown(() async => locator.reset());

  testWidgets(
      'kit download: spinner while busy, per-trade file name, complete notice '
      'on the SAME screen', (WidgetTester tester) async {
    await pumpScreen(tester);
    final Completer<String> urlGate = Completer<String>();
    when(() => repo.downloadUrl(any())).thenAnswer((_) => urlGate.future);

    await tester.tap(find.byIcon(Icons.download));
    await tester.pump();

    // Busy: the spinner replaces the icon button — a second tap is impossible.
    expect(find.byIcon(Icons.download), findsNothing);
    expect(find.text(kDownloadStartedNotice), findsOneWidget);
    // Still on the detail screen.
    expect(find.text('CNC Operator'), findsOneWidget);

    urlGate.complete('mock://downloads/interview-kit/mock-kit-0001.pdf');
    await tester.pump();
    await tester.pump();

    expect(find.text(kDownloadCompleteNotice), findsOneWidget);
    verify(() => repo.downloadUrl('cnc_operator')).called(1);

    final MethodCall save =
        channelCalls.singleWhere((MethodCall c) => c.method == 'saveToDownloads');
    expect((save.arguments as Map<dynamic, dynamic>)['fileName'],
        'BadaBhai-Interview-Kit-cnc_operator.pdf');

    // The download action is available again.
    expect(find.byIcon(Icons.download), findsOneWidget);
  });
}
