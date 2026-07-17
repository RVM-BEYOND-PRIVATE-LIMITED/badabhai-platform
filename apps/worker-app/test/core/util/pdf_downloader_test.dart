import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/error/failure_reason.dart';
import 'package:badabhai_worker_app/core/util/pdf_downloader.dart';

/// Records requests; serves whatever [_handler] returns. Injected so no test
/// ever touches the network.
class _StubHttpClient extends http.BaseClient {
  _StubHttpClient(this._handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest) _handler;
  final List<Uri> requested = <Uri>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requested.add(request.url);
    return _handler(request);
  }
}

class _FakeSaver implements PdfSaver {
  _FakeSaver({this.throwOnSave = false, this.public = true, this.displayPath});

  final bool throwOnSave;
  final bool public;

  /// What the real Kotlin saver now reports back: the human-readable location.
  /// Null models an older platform side that reports none.
  final String? displayPath;
  int calls = 0;
  String? tempPath;
  String? savedFileName;
  List<int>? bytesAtSave;

  @override
  Future<SavedPdf> save({
    required String tempPath,
    required String fileName,
  }) async {
    calls++;
    if (throwOnSave) throw StateError('disk full');
    this.tempPath = tempPath;
    savedFileName = fileName;
    // Snapshot what actually reached the platform seam (the temp is deleted
    // right after the helper returns).
    bytesAtSave = File(tempPath).readAsBytesSync();
    return SavedPdf(
      location: 'content://downloads/42',
      displayName: fileName,
      inPublicDownloads: public,
      displayPath: displayPath,
    );
  }
}

class _FakeOpener implements SavedPdfOpener {
  _FakeOpener({this.canOpen = true});

  final bool canOpen;
  final List<String> opened = <String>[];

  @override
  Future<bool> open(String location) async {
    opened.add(location);
    return canOpen;
  }
}

/// Minimal host: one button that kicks off [downloadSignedPdf] and exposes the
/// returned future so tests can drive its real file I/O with `runAsync`.
class _Harness extends StatelessWidget {
  const _Harness({required this.onTap});

  final Future<void> Function(BuildContext) onTap;

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => Center(
              child: ElevatedButton(
                onPressed: () => onTap(context),
                child: const Text('go'),
              ),
            ),
          ),
        ),
      );
}

void main() {
  _transientRetryTests();
  _downloadNotificationTests();

  testWidgets(
      'happy path: fetch → save → complete notice, and "Kholein" opens the '
      'SAVED LOCAL file', (WidgetTester tester) async {
    final List<int> pdfBytes = <int>[0x25, 0x50, 0x44, 0x46, 1, 2, 3];
    final _StubHttpClient client = _StubHttpClient(
      (_) async => http.StreamedResponse(
        http.ByteStream.fromBytes(pdfBytes),
        200,
      ),
    );
    final _FakeSaver saver = _FakeSaver();
    final _FakeOpener opener = _FakeOpener();

    await tester.pumpWidget(_Harness(onTap: (_) async {}));
    final BuildContext context = tester.element(find.text('go'));

    // The whole call runs inside runAsync: the temp-file streaming is REAL
    // I/O, which can only complete in the real async zone. (The mid-flight
    // "started" notice is locked by the gated tests + the screen tests, which
    // have no real I/O.)
    await tester.runAsync(
      () => downloadSignedPdf(
        context,
        resolve: () async => 'https://storage.example/x.pdf?token=tok_TEST',
        fileName: 'BadaBhai-Resume.pdf',
        client: client,
        saver: saver,
        opener: opener,
      ),
    );
    await tester.pump();

    expect(find.text(kDownloadCompleteNotice), findsOneWidget);
    expect(find.text(kDownloadOpenActionLabel), findsOneWidget);
    // The bytes were fetched from the RESOLVED url, in-app.
    expect(client.requested.single.toString(),
        'https://storage.example/x.pdf?token=tok_TEST');
    // The platform seam got the requested display name and the exact bytes.
    expect(saver.savedFileName, 'BadaBhai-Resume.pdf');
    expect(saver.bytesAtSave, pdfBytes);
    // The cache temp file is cleaned up after the save.
    expect(File(saver.tempPath!).existsSync(), isFalse);

    // Let the SnackBar's entrance animation finish (it ignores pointers while
    // animating in), then the action opens the SAVED LOCAL file.
    await tester.pumpAndSettle();
    await tester.tap(find.text(kDownloadOpenActionLabel));
    await tester.pump();
    expect(opener.opened, <String>['content://downloads/42']);
  });

  testWidgets(
      'a typed Failure from resolve() shows ITS honest reason — never a '
      'generic line — and nothing is fetched or saved',
      (WidgetTester tester) async {
    final _StubHttpClient client = _StubHttpClient(
        (_) async => throw StateError('must not fetch'));
    final _FakeSaver saver = _FakeSaver();
    final Completer<String?> gate = Completer<String?>();

    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => downloadSignedPdf(
        context,
        resolve: () => gate.future,
        fileName: 'BadaBhai-Resume.pdf',
        client: client,
        saver: saver,
        opener: _FakeOpener(),
      ),
    ));

    await tester.tap(find.text('go'));
    await tester.pump();
    expect(find.text(kDownloadStartedNotice), findsOneWidget);

    gate.completeError(const ResumeNotReadyFailure());
    await tester.pump();
    await tester.pump();

    expect(
      find.text(failureReason(const ResumeNotReadyFailure()).reason),
      findsOneWidget,
    );
    expect(find.text(kDownloadStartedNotice), findsNothing);
    expect(client.requested, isEmpty);
    expect(saver.calls, 0);
  });

  testWidgets('a 401 from resolve() shows the session copy',
      (WidgetTester tester) async {
    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => downloadSignedPdf(
        context,
        resolve: () async => throw const UnauthorizedFailure(),
        fileName: 'BadaBhai-Resume.pdf',
        client: _StubHttpClient((_) async => throw StateError('no fetch')),
        saver: _FakeSaver(),
        opener: _FakeOpener(),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    await tester.pump();
    expect(
      find.text(failureReason(const UnauthorizedFailure()).reason),
      findsOneWidget,
    );
  });

  testWidgets('a non-200 on the byte fetch shows the honest server-error copy',
      (WidgetTester tester) async {
    final _StubHttpClient client = _StubHttpClient(
      (_) async =>
          http.StreamedResponse(const Stream<List<int>>.empty(), 503),
    );
    final _FakeSaver saver = _FakeSaver();

    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => downloadSignedPdf(
        context,
        resolve: () async => 'https://storage.example/x.pdf?token=t',
        fileName: 'BadaBhai-Resume.pdf',
        client: client,
        saver: saver,
        opener: _FakeOpener(),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    // A 5xx is now RETRIED (bounded) before the worker is told — the honest copy
    // arrives once the budget is spent, not on the first blip. Advance past the
    // 400ms + 800ms backoff.
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    expect(
      find.text(failureReason(const ServerFailure(503)).reason),
      findsOneWidget,
    );
    expect(saver.calls, 0);
  });

  testWidgets(
      'a hung download hits the bound and shows the network copy '
      '(typed, never an infinite spinner)', (WidgetTester tester) async {
    final _StubHttpClient client = _StubHttpClient(
        (_) => Completer<http.StreamedResponse>().future); // never completes

    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => downloadSignedPdf(
        context,
        resolve: () async => 'https://storage.example/x.pdf?token=t',
        fileName: 'BadaBhai-Resume.pdf',
        client: client,
        saver: _FakeSaver(),
        opener: _FakeOpener(),
        timeout: const Duration(milliseconds: 200),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    expect(find.text(kDownloadStartedNotice), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.text(failureReason(const NetworkFailure()).reason),
      findsOneWidget,
    );
  });

  testWidgets('a platform save error shows the storage copy',
      (WidgetTester tester) async {
    final _StubHttpClient client = _StubHttpClient(
      (_) async => http.StreamedResponse(
        http.ByteStream.fromBytes(<int>[1, 2, 3]),
        200,
      ),
    );

    await tester.pumpWidget(_Harness(onTap: (_) async {}));
    final BuildContext context = tester.element(find.text('go'));
    // Real temp-file I/O → the call must run inside runAsync (see happy path).
    await tester.runAsync(
      () => downloadSignedPdf(
        context,
        resolve: () async => 'https://storage.example/x.pdf?token=t',
        fileName: 'BadaBhai-Resume.pdf',
        client: client,
        saver: _FakeSaver(throwOnSave: true),
        opener: _FakeOpener(),
      ),
    );
    await tester.pump();

    expect(find.text(kDownloadSaveFailureNotice), findsOneWidget);
  });

  testWidgets(
      'mock:// sentinel url: no fetch — a placeholder PDF is saved so the '
      'flow stays walkable offline', (WidgetTester tester) async {
    final _StubHttpClient client = _StubHttpClient(
        (_) async => throw StateError('mock mode must not fetch'));
    final _FakeSaver saver = _FakeSaver();

    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => downloadSignedPdf(
        context,
        resolve: () async => 'mock://downloads/interview-kit/mock-kit-0001.pdf',
        fileName: 'BadaBhai-Interview-Kit-cnc_operator.pdf',
        client: client,
        saver: saver,
        opener: _FakeOpener(),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    await tester.pump();

    expect(find.text(kDownloadCompleteNotice), findsOneWidget);
    expect(client.requested, isEmpty);
    expect(saver.savedFileName, 'BadaBhai-Interview-Kit-cnc_operator.pdf');
    // A real (tiny) PDF reached the platform seam.
    expect(saver.bytesAtSave!.sublist(0, 4), <int>[0x25, 0x50, 0x44, 0x46]);
    expect(File(saver.tempPath!).existsSync(), isFalse);
  });

  testWidgets(
      'pre-Android-10 fallback save keeps the copy honest about the location',
      (WidgetTester tester) async {
    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => downloadSignedPdf(
        context,
        resolve: () async => 'mock://downloads/resume/mock-resume-0001.pdf',
        fileName: 'BadaBhai-Resume.pdf',
        client: _StubHttpClient((_) async => throw StateError('no fetch')),
        saver: _FakeSaver(public: false),
        opener: _FakeOpener(),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    await tester.pump();

    expect(find.text(kDownloadCompleteFallbackNotice), findsOneWidget);
    expect(find.text(kDownloadCompleteNotice), findsNothing);
  });

  testWidgets('"Kholein" with no PDF viewer installed shows the honest copy',
      (WidgetTester tester) async {
    final _FakeOpener opener = _FakeOpener(canOpen: false);

    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => downloadSignedPdf(
        context,
        resolve: () async => 'mock://downloads/resume/mock-resume-0001.pdf',
        fileName: 'BadaBhai-Resume.pdf',
        client: _StubHttpClient((_) async => throw StateError('no fetch')),
        saver: _FakeSaver(),
        opener: opener,
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    await tester.pump();
    expect(find.text(kDownloadOpenActionLabel), findsOneWidget);

    // Wait out the entrance animation so the action is tappable; after the tap
    // the action's own hide animation must finish before the queued no-viewer
    // notice enters, so settle again rather than zero-duration pumps.
    await tester.pumpAndSettle();
    await tester.tap(find.text(kDownloadOpenActionLabel));
    await tester.pumpAndSettle();

    expect(opener.opened, hasLength(1));
    expect(find.text(kDownloadNoViewerNotice), findsOneWidget);
  });

  testWidgets(
      'PRIVACY LOCK: no code path logs, shows, or hands out the signed url — '
      'only the LOCAL file crosses the save/open seams',
      (WidgetTester tester) async {
    const String token = 'tok_SUPER_SECRET_651';
    const String signedUrl = 'https://storage.example/signed.pdf?token=$token';

    // Capture EVERYTHING that could reach a log: debugPrint and Zone print.
    // debugPrint is restored INSIDE the test body (not addTearDown) — the
    // binding's foundation-vars invariant check runs before tearDowns.
    final List<String> logged = <String>[];
    final DebugPrintCallback originalDebugPrint = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) logged.add(message);
    };
    final ZoneSpecification captureSpec = ZoneSpecification(
      print: (Zone self, ZoneDelegate parent, Zone zone, String line) =>
          logged.add(line),
    );

    final _FakeSaver saver = _FakeSaver();
    final _FakeOpener opener = _FakeOpener();
    final _StubHttpClient okClient = _StubHttpClient(
      (_) async => http.StreamedResponse(
        http.ByteStream.fromBytes(<int>[1, 2, 3]),
        200,
      ),
    );

    // Success path (fetch → save → open). Real temp-file I/O → the call runs
    // inside runAsync, wrapped in the print-capturing zone.
    await tester.pumpWidget(_Harness(onTap: (_) async {}));
    final BuildContext successContext = tester.element(find.text('go'));
    await tester.runAsync(
      () => runZoned(
        () => downloadSignedPdf(
          successContext,
          resolve: () async => signedUrl,
          fileName: 'BadaBhai-Resume.pdf',
          client: okClient,
          saver: saver,
          opener: opener,
        ),
        zoneSpecification: captureSpec,
      ),
    );
    await tester.pump();
    expect(find.textContaining(token), findsNothing); // never SHOWN
    await tester.pumpAndSettle(); // entrance animation → action tappable
    await tester.tap(find.text(kDownloadOpenActionLabel));
    await tester.pump();

    // Failure path (non-200) through the same zone capture — no real I/O, so
    // the plain tap + pump flow drives it.
    final _StubHttpClient failClient = _StubHttpClient(
      (_) async =>
          http.StreamedResponse(const Stream<List<int>>.empty(), 500),
    );
    await tester.pumpWidget(_Harness(
      onTap: (BuildContext context) => runZoned(
        () => downloadSignedPdf(
          context,
          resolve: () async => signedUrl,
          fileName: 'BadaBhai-Resume.pdf',
          client: failClient,
          saver: saver,
          opener: opener,
        ),
        zoneSpecification: captureSpec,
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    // The 500 is retried (bounded) before the failure surfaces — advance past
    // the backoff so the whole failure path, retries included, is covered by
    // this privacy lock.
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.textContaining(token), findsNothing);

    debugPrint = originalDebugPrint;

    // Never LOGGED (debugPrint or print) on any path.
    expect(logged.where((String l) => l.contains(token)), isEmpty);
    // Only LOCAL values crossed the platform seams — no url, no token.
    expect(saver.tempPath, isNot(contains(token)));
    expect(saver.savedFileName, isNot(contains(token)));
    expect(opener.opened.join(), isNot(contains(token)));
  });

  test('placeholder PDF is a structurally plausible, PII-free document', () {
    final List<int> bytes = buildPlaceholderPdfBytes();
    final String text = String.fromCharCodes(bytes);
    expect(text, startsWith('%PDF-1.4'));
    expect(text, endsWith('%%EOF\n'));
    expect(text, contains('BadaBhai sample PDF - mock download'));
    // Every byte is ASCII so xref offsets are exact.
    expect(bytes.every((int b) => b < 128), isTrue);
  });
}

/// The reported symptom: "Server error (500), thodi der baad" — then the very
/// next tap downloads fine. Only the 409 (still-rendering) case was ever
/// retried, so a transient 5xx on either leg fell straight through to a failure
/// notice. A blip the worker fixes by tapping again is a blip the app should
/// ride out itself.
void _transientRetryTests() {
  testWidgets('a transient 500 on the STORAGE fetch is ridden out, not surfaced',
      (WidgetTester tester) async {
    final List<int> pdfBytes = <int>[0x25, 0x50, 0x44, 0x46, 9];
    int calls = 0;
    final _StubHttpClient client = _StubHttpClient((_) async {
      calls++;
      // Supabase Storage blips 500 on the signed-url GET, then serves fine.
      if (calls == 1) {
        return http.StreamedResponse(http.ByteStream.fromBytes(<int>[]), 500);
      }
      return http.StreamedResponse(http.ByteStream.fromBytes(pdfBytes), 200);
    });

    await tester.pumpWidget(_Harness(onTap: (_) async {}));
    final BuildContext context = tester.element(find.text('go'));

    await tester.runAsync(
      () => downloadSignedPdf(
        context,
        resolve: () async => 'https://storage.example/x.pdf?token=t',
        fileName: 'BadaBhai-Resume.pdf',
        client: client,
        saver: _FakeSaver(),
        opener: _FakeOpener(),
      ),
    );
    await tester.pump();

    expect(calls, 2, reason: 'the app retried so the worker did not have to');
    expect(find.text(kDownloadCompleteNotice), findsOneWidget);
    expect(find.textContaining('Server error'), findsNothing);
  });

  testWidgets('a NON-transient 4xx still fails fast and honestly',
      (WidgetTester tester) async {
    int calls = 0;
    final _StubHttpClient client = _StubHttpClient((_) async {
      calls++;
      // 403 = the signed url expired. Retrying cannot fix that.
      return http.StreamedResponse(http.ByteStream.fromBytes(<int>[]), 403);
    });

    await tester.pumpWidget(_Harness(onTap: (_) async {}));
    final BuildContext context = tester.element(find.text('go'));

    await tester.runAsync(
      () => downloadSignedPdf(
        context,
        resolve: () async => 'https://storage.example/x.pdf?token=t',
        fileName: 'BadaBhai-Resume.pdf',
        client: client,
        saver: _FakeSaver(),
        opener: _FakeOpener(),
      ),
    );
    await tester.pump();

    expect(calls, 1, reason: 'no pointless waiting on a considered answer');
    expect(find.text(kDownloadCompleteNotice), findsNothing);
  });
}

/// The download-complete NOTIFICATION: the receipt the system Download Manager
/// gives you and an in-app download does not. The SnackBar is gone the moment
/// the worker leaves the screen; this is what they still have when they want to
/// find the file later.
void _downloadNotificationTests() {
  const MethodChannel channel = MethodChannel('badabhai.workerapp/downloads');

  /// A saver that reports WHERE it wrote, exactly as the Kotlin side now does.
  _FakeSaver savingTo(String displayPath) =>
      _FakeSaver(displayPath: displayPath);

  Future<void> runDownload(
    WidgetTester tester, {
    required PdfSaver saver,
  }) async {
    final _StubHttpClient client = _StubHttpClient(
      (_) async => http.StreamedResponse(
        http.ByteStream.fromBytes(<int>[0x25, 0x50, 0x44, 0x46]),
        200,
      ),
    );
    await tester.pumpWidget(_Harness(onTap: (_) async {}));
    final BuildContext context = tester.element(find.text('go'));
    await tester.runAsync(
      () => downloadSignedPdf(
        context,
        resolve: () async => 'https://storage.example/x.pdf?token=tok_SECRET',
        fileName: 'RAMESH_KUMAR_RESUME.pdf',
        client: client,
        saver: saver,
        opener: _FakeOpener(),
      ),
    );
    await tester.pump();
  }

  testWidgets('a successful save posts the notification with name + path',
      (WidgetTester tester) async {
    final List<MethodCall> calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (MethodCall c) async {
      calls.add(c);
      return true;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    await runDownload(tester,
        saver: savingTo('Downloads/RAMESH_KUMAR_RESUME.pdf'));

    final MethodCall call =
        calls.singleWhere((MethodCall c) => c.method == 'notifyDownloadComplete');
    final Map<dynamic, dynamic> args = call.arguments as Map<dynamic, dynamic>;
    expect(args['displayName'], 'RAMESH_KUMAR_RESUME.pdf');
    expect(args['displayPath'], 'Downloads/RAMESH_KUMAR_RESUME.pdf');
    expect(args['location'], isNotEmpty);
  });

  testWidgets('PRIVACY: the signed url never reaches the notification',
      (WidgetTester tester) async {
    final List<MethodCall> calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (MethodCall c) async {
      calls.add(c);
      return true;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    await runDownload(tester, saver: savingTo('Downloads/x.pdf'));

    // Only LOCAL values cross the channel — a token in a notification would sit
    // in the OS shade, readable and retained.
    expect(calls.toString(), isNot(contains('tok_SECRET')));
    expect(calls.toString(), isNot(contains('storage.example')));
  });

  testWidgets('a NOTIFICATION FAILURE never fails the download',
      (WidgetTester tester) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (MethodCall c) async {
      // Permission denied / channel muted / OEM quirk — the file is already on
      // disk, so none of it may cost the worker their download.
      throw PlatformException(code: 'notify_failed');
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    await runDownload(tester, saver: savingTo('Downloads/x.pdf'));

    expect(tester.takeException(), isNull);
    expect(find.text('Download complete — Downloads/x.pdf mein hai'),
        findsOneWidget);
    expect(find.text(kDownloadOpenActionLabel), findsOneWidget);
  });

  testWidgets('NO platform side at all (MissingPlugin) still completes',
      (WidgetTester tester) async {
    // No mock handler registered → MissingPluginException.
    await runDownload(tester, saver: savingTo('Downloads/x.pdf'));

    expect(tester.takeException(), isNull);
    expect(find.text('Download complete — Downloads/x.pdf mein hai'),
        findsOneWidget);
  });

  testWidgets('the SnackBar names the REAL path, not "Downloads folder"',
      (WidgetTester tester) async {
    await runDownload(tester,
        saver: savingTo('Downloads/RAMESH_KUMAR_RESUME.pdf'));

    expect(
      find.text('Download complete — Downloads/RAMESH_KUMAR_RESUME.pdf mein hai'),
      findsOneWidget,
    );
    // The vague old line is gone when a real path is known.
    expect(find.text(kDownloadCompleteNotice), findsNothing);
  });

  testWidgets('no displayPath → falls back to the old copy, no notification',
      (WidgetTester tester) async {
    final List<MethodCall> calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel,
        (MethodCall c) async {
      calls.add(c);
      return true;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    // An older platform side that reports no path: better vague than fabricated,
    // and a notification whose job is to say WHERE has nothing to say.
    await runDownload(tester, saver: _FakeSaver());

    expect(calls.where((MethodCall c) => c.method == 'notifyDownloadComplete'),
        isEmpty);
    expect(find.text(kDownloadCompleteNotice), findsOneWidget);
  });
}
