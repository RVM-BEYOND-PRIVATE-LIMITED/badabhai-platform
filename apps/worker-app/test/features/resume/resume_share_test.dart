import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/error/failure_reason.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

/// Records the urls actually requested and serves canned bytes. Injected so no
/// test touches the network — and so a test can prove the signed url was spent
/// IN-APP on a byte fetch rather than handed to the share sheet.
class _StubHttpClient extends http.BaseClient {
  _StubHttpClient({this.statusCode = 200, required this.body});

  final int statusCode;
  final List<int> body;
  final List<Uri> requested = <Uri>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requested.add(request.url);
    return http.StreamedResponse(
      Stream<List<int>>.value(body),
      statusCode,
    );
  }
}

/// What actually crossed the share boundary. Bytes + a file name — by
/// construction there is nowhere here for a url to hide (#354).
class _SharedDocument {
  const _SharedDocument({
    required this.bytes,
    required this.fileName,
    required this.text,
  });

  final Uint8List bytes;
  final String fileName;
  final String text;
}

/// #336 — the resume WhatsApp/share affordance that the alpha build kit skipped.
///
/// The load-bearing assertion in this file is the #354 one: the resume url is a
/// SIGNED, time-limited credential, so the share path must send the PDF's BYTES
/// and never the link. A url in a chat thread gets forwarded forever and pulls
/// the worker's resume for as long as the signature lives.
void main() {
  /// The signed credential the API mints. Its token is deliberately a
  /// searchable sentinel: every test asserts it never reaches the share sheet.
  const String signedUrl = 'https://storage.example.test/resumes/r-1.pdf'
      '?token=SIGNED-SECRET-SIGNATURE&expires=9999';

  final Uint8List pdfBytes =
      Uint8List.fromList(utf8.encode('%PDF-1.4 pretend resume bytes'));

  late MockResumeRepository repo;
  late MockResumeEditRepository editRepo;
  late _StubHttpClient client;
  late List<_SharedDocument> shared;

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    repo = MockResumeRepository();
    editRepo = MockResumeEditRepository();
    client = _StubHttpClient(body: pdfBytes);
    shared = <_SharedDocument>[];
    when(() => editRepo.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Ramesh Kumar',
        showPhoto: false,
        nightShiftReady: false,
      ),
    );
    locator.registerFactory<ResumeCubit>(() => ResumeCubit(repo));
    // The preview screen refetches on tab focus (T4) and resolves this.
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
    // The share button reads the worker's name from here to name the document.
    locator.registerFactory<ResumeEditRepository>(() => editRepo);
  });

  tearDown(() async => locator.reset());

  void sizeView(WidgetTester tester) {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  /// The share button alone, with both production seams faked.
  Future<void> pumpShareButton(WidgetTester tester) async {
    sizeView(tester);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: BlocProvider<ResumeCubit>(
        create: (_) => locator<ResumeCubit>()..showGenerated('MOCK RESUME BODY'),
        child: Scaffold(
          body: ResumeShareButton(
            httpClient: client,
            share: ({
              required Uint8List bytes,
              required String fileName,
              required String text,
            }) async {
              shared.add(_SharedDocument(
                bytes: bytes,
                fileName: fileName,
                text: text,
              ));
            },
          ),
        ),
      ),
    ));
    await tester.pump();
  }

  testWidgets(
      'the share affordance renders on the resume card, alongside Download',
      (WidgetTester tester) async {
    sizeView(tester);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const ResumePreviewScreen(initialResume: 'MOCK RESUME BODY'),
    ));
    await tester.pump();
    await tester.pump();

    // The parity gap #336 named: the worker could save the PDF but had no way
    // to send it to the factory owner who asked for it.
    expect(find.widgetWithText(BbButton, kResumeShareLabel), findsOneWidget);
    // …and it is ADDITIVE — Download and Edit are untouched.
    expect(find.widgetWithText(BbButton, 'Download Resume'), findsOneWidget);
    expect(find.widgetWithText(BbButton, 'Edit resume'), findsOneWidget);
  });

  testWidgets(
      'shares the PDF FILE — bytes + the derived document name — and the '
      'signed url never crosses the share boundary (#354)',
      (WidgetTester tester) async {
    when(() => repo.resumeDownloadUrl()).thenAnswer((_) async => signedUrl);
    await pumpShareButton(tester);

    await tester.tap(find.text(kResumeShareLabel));
    await tester.pumpAndSettle();

    expect(shared, hasLength(1));
    final _SharedDocument doc = shared.single;

    // The DOCUMENT ITSELF travelled — the factory owner opens a PDF, not a link.
    expect(doc.bytes, pdfBytes);
    // Named from the worker's OWN name, so the chat shows whose resume it is.
    expect(doc.fileName, 'RAMESH_KUMAR_RESUME.pdf');

    // #354 — the credential must appear NOWHERE in what left the app. A signed
    // url in a chat thread is forwardable forever and pulls the worker's resume
    // until the signature expires.
    expect(doc.text, isNot(contains('SIGNED-SECRET-SIGNATURE')));
    expect(doc.text, isNot(contains('http')));
    expect(doc.fileName, isNot(contains('SIGNED-SECRET-SIGNATURE')));
    expect(utf8.decode(doc.bytes), isNot(contains('SIGNED-SECRET-SIGNATURE')));

    // The url WAS spent — in-app, on exactly one byte fetch.
    expect(client.requested, <Uri>[Uri.parse(signedUrl)]);
  });

  testWidgets(
      'never downloaded: share mints and fetches the PDF itself — busy button, '
      'honest "taiyaar kar rahe hain" notice, then a real file. No dead button, '
      'no silent no-op', (WidgetTester tester) async {
    // Gate the mint so the in-between state is deterministically observable.
    final Completer<String> urlGate = Completer<String>();
    when(() => repo.resumeDownloadUrl()).thenAnswer((_) => urlGate.future);
    await pumpShareButton(tester);

    // Download was NEVER tapped — nothing is staged in Downloads.
    await tester.tap(find.text(kResumeShareLabel));
    await tester.pump();

    expect(find.text(kResumeSharePreparingNotice), findsOneWidget);
    expect(
      tester
          .widget<BbButton>(find.widgetWithText(BbButton, kResumeShareLabel))
          .loading,
      isTrue,
    );

    // A second tap while busy is inert (BbButton drops onPressed) — one sheet,
    // one fetch.
    await tester.tap(find.text(kResumeShareLabel), warnIfMissed: false);
    await tester.pump();

    urlGate.complete(signedUrl);
    await tester.pumpAndSettle();

    // Download-then-share resolved on its own: the worker got the file without
    // ever being told to "download it first".
    expect(shared, hasLength(1));
    expect(shared.single.bytes, pdfBytes);
    verify(() => repo.resumeDownloadUrl()).called(1);
    expect(client.requested, hasLength(1));

    // Busy state released, and the "taiyaar kar rahe hain" line is gone — the
    // share sheet is the confirmation, so we don't stack a notice on top of it.
    expect(
      tester
          .widget<BbButton>(find.widgetWithText(BbButton, kResumeShareLabel))
          .loading,
      isFalse,
    );
    expect(find.text(kResumeSharePreparingNotice), findsNothing);
  });

  testWidgets(
      'a failed mint states the REAL reason and shares NOTHING — never falls '
      'back to sharing the link', (WidgetTester tester) async {
    when(() => repo.resumeDownloadUrl()).thenThrow(const UnauthorizedFailure());
    await pumpShareButton(tester);

    await tester.tap(find.text(kResumeShareLabel));
    await tester.pumpAndSettle();

    // The actual cause ("Session khatam ho gaya…"), not a generic
    // "check your internet".
    expect(
      find.text(failureReason(const UnauthorizedFailure()).reason),
      findsOneWidget,
    );
    expect(shared, isEmpty);
    expect(client.requested, isEmpty);
  });

  testWidgets(
      'a non-200 on the byte fetch surfaces the server status and shares '
      'nothing', (WidgetTester tester) async {
    client = _StubHttpClient(statusCode: 404, body: const <int>[]);
    when(() => repo.resumeDownloadUrl()).thenAnswer((_) async => signedUrl);
    await pumpShareButton(tester);

    await tester.tap(find.text(kResumeShareLabel));
    await tester.pumpAndSettle();

    expect(
      find.text(failureReason(const ServerFailure(404)).reason),
      findsOneWidget,
    );
    // A half-fetched or empty body must never be passed off as the resume.
    expect(shared, isEmpty);
  });

  testWidgets(
      'mock mode says so instead of sending a corrupt zero-byte "resume"',
      (WidgetTester tester) async {
    when(() => repo.resumeDownloadUrl())
        .thenAnswer((_) async => 'mock://downloads/resume/mock-resume-0001.pdf');
    await pumpShareButton(tester);

    await tester.tap(find.text(kResumeShareLabel));
    await tester.pumpAndSettle();

    expect(find.text(kResumeShareMockNotice), findsOneWidget);
    expect(shared, isEmpty);
    expect(client.requested, isEmpty);
  });
}
