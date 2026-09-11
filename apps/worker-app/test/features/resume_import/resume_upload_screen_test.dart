import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/storage/signed_object_put.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/features/resume_import/data/resume_importer_impl.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document_picker.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_screen.dart';
import 'package:badabhai_worker_app/router.dart';

const String _kChatMarker = 'CHAT_SCREEN_MARKER';
const String _kTradeFormMarker = 'TRADE_FORM_SCREEN_MARKER';

const String _kDoorUpload = 'Resume upload karein';
const String _kDoorChat = 'Hinglish mein baat karein';
const String _kDoorNoResume = 'Mere paas resume nahi hai';

/// A picker that hands back whatever the test tells it to, and records that it
/// was asked.
class _FakePicker implements ResumeDocumentPicker {
  _FakePicker(this.result);

  ResumePickResult result;
  int calls = 0;

  @override
  Future<ResumePickResult> pickResume() async {
    calls++;
    return result;
  }
}

class _FakeImporter implements ResumeImporter {
  _FakeImporter(this.outcome);

  ResumeImportOutcome outcome;
  int calls = 0;

  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument d) async {
    calls++;
    return outcome;
  }
}

ResumePickResult _picked() => ResumePickResult.picked(
      PickedResumeDocument(
        kind: ResumeDocumentKind.pdf,
        bytes: Uint8List(1024),
      ),
    );

/// Pumps the screen with the two seams stubbed and a router carrying markers
/// for both of its possible destinations.
///
/// Returns the router so a test can read `matchedLocation` — the ROUTE, not a
/// marker string, is what "byte-for-byte today's behaviour" is about.
Future<GoRouter> _pump(
  WidgetTester tester, {
  required ResumeDocumentPicker picker,
  required ResumeImporter importer,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  locator.registerLazySingleton<ResumeDocumentPicker>(() => picker);
  locator.registerLazySingleton<ResumeImporter>(() => importer);

  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final GoRouter router = GoRouter(
    initialLocation: Routes.resumeUpload,
    routes: <RouteBase>[
      GoRoute(
        path: Routes.resumeUpload,
        builder: (_, __) => const ResumeUploadScreen(),
      ),
      GoRoute(
        path: Routes.chatProfiling,
        builder: (_, __) => const Scaffold(body: Text(_kChatMarker)),
      ),
      GoRoute(
        path: Routes.tradeForm,
        builder: (_, __) => const Scaffold(body: Text(_kTradeFormMarker)),
      ),
    ],
  );
  addTearDown(router.dispose);
  addTearDown(locator.reset);

  await tester.pumpWidget(
    MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
  );
  await tester.pump();
  return router;
}

String _where(GoRouter router) =>
    router.routerDelegate.currentConfiguration.matches.last.matchedLocation;

void main() {
  group('the three doors', () {
    testWidgets('all three are on screen from the first frame', (
      WidgetTester tester,
    ) async {
      await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: _FakeImporter(const ResumeImportRoutedToChat()),
      );

      expect(find.text(_kDoorUpload), findsOneWidget);
      expect(find.text(_kDoorChat), findsOneWidget);
      expect(find.text(_kDoorNoResume), findsOneWidget);
    });
  });

  // ── THE REQUIREMENT THIS WHOLE SCREEN IS SHAPED BY ────────────────────────
  //
  // "Doors 2 and 3 must be today's behaviour byte for byte. Pin with a test
  // that the request sequence and first chat turn are identical to main."
  //
  // On `main`, `/name` handed straight to `Routes.chatProfiling` and the FIRST
  // request anything made after that was the chat's own. So the property to
  // pin is: inserting this screen contributes ZERO requests to the sequence,
  // and lands on the SAME route. Asserted at the HTTP layer with a recording
  // client behind the real `ResumeImporterImpl` — not at the importer
  // interface, because a fake importer could only prove the screen did not
  // call the fake.
  //
  // The chat's own first turn follows from that: if the sequence up to the
  // moment `/chat` builds is byte-identical, the chat's first request is
  // whatever it always was. (`app_journey_test.dart` walks door 3 through the
  // real chat end-to-end, which is the other half of this pin.)
  group('doors 2 and 3 are today\'s behaviour, byte for byte', () {
    /// The real importer over a client that records — and fails — any request.
    ({ResumeImporterImpl importer, List<String> requests}) recordingImporter() {
      final List<String> requests = <String>[];
      final MockClient client = MockClient((http.Request req) async {
        requests.add('${req.method} ${req.url}');
        return http.Response('{}', 200);
      });
      return (
        importer: ResumeImporterImpl(
          api: ApiClient(baseUrl: 'http://test', client: client),
          session: SessionRepository()..setSessionToken('tok'),
          put: SignedObjectPut(client: client),
        ),
        requests: requests,
      );
    }

    testWidgets('building the screen issues NO request', (
      WidgetTester tester,
    ) async {
      final ({ResumeImporterImpl importer, List<String> requests}) h =
          recordingImporter();
      await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: h.importer,
      );
      await tester.pump(const Duration(seconds: 2));

      // No capability probe, no "is the bucket set" check, nothing.
      expect(h.requests, isEmpty);
    });

    testWidgets('door 2 goes to /chat with NO request of its own', (
      WidgetTester tester,
    ) async {
      final ({ResumeImporterImpl importer, List<String> requests}) h =
          recordingImporter();
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: h.importer,
      );

      await tester.tap(find.text(_kDoorChat));
      await tester.pumpAndSettle();

      expect(_where(router), Routes.chatProfiling);
      expect(find.text(_kChatMarker), findsOneWidget);
      expect(h.requests, isEmpty);
      // And nothing is said on the way — a plain continue, exactly as before.
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('door 3 goes to /chat with NO request of its own', (
      WidgetTester tester,
    ) async {
      final ({ResumeImporterImpl importer, List<String> requests}) h =
          recordingImporter();
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: h.importer,
      );

      await tester.tap(find.text(_kDoorNoResume));
      await tester.pumpAndSettle();

      expect(_where(router), Routes.chatProfiling);
      expect(find.text(_kChatMarker), findsOneWidget);
      expect(h.requests, isEmpty);
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('neither door opens the document picker', (
      WidgetTester tester,
    ) async {
      final _FakePicker picker = _FakePicker(_picked());
      final _FakeImporter importer =
          _FakeImporter(const ResumeImportRoutedToChat());
      await _pump(tester, picker: picker, importer: importer);

      await tester.tap(find.text(_kDoorNoResume));
      await tester.pumpAndSettle();

      expect(picker.calls, 0);
      expect(importer.calls, 0);
    });

    testWidgets('`go`, not `push` — the résumé step is not left on the stack', (
      WidgetTester tester,
    ) async {
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: _FakeImporter(const ResumeImportRoutedToChat()),
      );

      await tester.tap(find.text(_kDoorChat));
      await tester.pumpAndSettle();

      // One entry, not two: onboarding is a one-way sequence and a pushed step
      // would let system back walk into a screen the worker has passed.
      expect(
        router.routerDelegate.currentConfiguration.matches.length,
        1,
      );
    });
  });

  group('door 1 — the upload', () {
    testWidgets('a parsed form route lands on the trade form', (
      WidgetTester tester,
    ) async {
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: _FakeImporter(
          const ResumeImportRoutedToForm(formKind: 'cnc_turner'),
        ),
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pumpAndSettle();

      expect(_where(router), Routes.tradeForm);
      expect(find.text(_kTradeFormMarker), findsOneWidget);
    });

    testWidgets('a chat route lands on the chat with nothing to explain', (
      WidgetTester tester,
    ) async {
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: _FakeImporter(const ResumeImportRoutedToChat()),
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pumpAndSettle();

      expect(_where(router), Routes.chatProfiling);
      // A résumé that routed to chat WORKED — there is no bad news to deliver.
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets(
        'the dormant bucket says so plainly and continues — never a dead end',
        (WidgetTester tester) async {
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: _FakeImporter(const ResumeImportUnavailable()),
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pump();
      await tester.pump();

      // Said on the way out, on the root messenger, so it survives the route
      // change and lands on the screen he is going to.
      //
      // `findsWidgets`, not `findsOneWidget`: ONE snackbar mounts twice in the
      // tree by Flutter's own design — the messenger's overlay entry and the
      // Scaffold's own snackbar slot render the same widget instance. Counting
      // elements here would be asserting a framework detail; the copy is what
      // matters.
      expect(find.byType(SnackBar), findsWidgets);
      expect(
        find.textContaining('Resume upload abhi shuru nahi hua hai'),
        findsWidgets,
      );
      expect(_where(router), Routes.chatProfiling);
    });

    testWidgets('a failure says one honest line and continues', (
      WidgetTester tester,
    ) async {
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: _FakeImporter(const ResumeImportFailed()),
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pump();
      await tester.pump();

      expect(
        find.textContaining('Resume se jaankari nahi mil paayi'),
        findsWidgets,
      );
      expect(_where(router), Routes.chatProfiling);
    });

    testWidgets('NO server failure_reason ever reaches the screen', (
      WidgetTester tester,
    ) async {
      await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: _FakeImporter(const ResumeImportFailed()),
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pump();
      await tester.pump();

      // The closed server vocabulary, in full. None of it is worker copy.
      for (final String reason in <String>[
        'no_text_layer',
        'ocr_below_floor',
        'unsupported_document',
        'encrypted_document',
        'empty_document',
        'parse_unavailable',
        'parse_deadline_exceeded',
        'parse_output_invalid',
      ]) {
        expect(find.textContaining(reason), findsNothing, reason: reason);
      }
    });
  });

  group('a rejected pick keeps him here, with something he can act on', () {
    testWidgets('a cancel says nothing and changes nothing', (
      WidgetTester tester,
    ) async {
      final _FakeImporter importer =
          _FakeImporter(const ResumeImportRoutedToChat());
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(
          const ResumePickResult.rejected(ResumePickRejection.cancelled),
        ),
        importer: importer,
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pumpAndSettle();

      // Backing out of a picker is not an event: still on the doors, no line,
      // nothing uploaded.
      expect(_where(router), Routes.resumeUpload);
      expect(find.text(_kDoorUpload), findsOneWidget);
      expect(importer.calls, 0);
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('a wrong file type names the four that work', (
      WidgetTester tester,
    ) async {
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(
          const ResumePickResult.rejected(ResumePickRejection.unsupportedType),
        ),
        importer: _FakeImporter(const ResumeImportRoutedToChat()),
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pumpAndSettle();

      expect(_where(router), Routes.resumeUpload);
      expect(
        find.textContaining('Sirf PDF, DOCX, JPG ya PNG'),
        findsOneWidget,
      );
      // The doors stay — he can pick again from where he is standing.
      expect(find.text(_kDoorUpload), findsOneWidget);
    });

    testWidgets('an over-sized file names the ceiling', (
      WidgetTester tester,
    ) async {
      await _pump(
        tester,
        picker: _FakePicker(
          const ResumePickResult.rejected(ResumePickRejection.tooLarge),
        ),
        importer: _FakeImporter(const ResumeImportRoutedToChat()),
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pumpAndSettle();

      expect(find.textContaining('10 MB'), findsOneWidget);
    });
  });

  group('the screen never double-fires', () {
    testWidgets('a second tap while the upload is in flight is ignored', (
      WidgetTester tester,
    ) async {
      // #1475's lesson, applied here: a worker on a slow phone taps twice, and
      // the second tap must not register a second import or race the first
      // navigation.
      final _CountingImporter importer = _CountingImporter();
      await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: importer,
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pump();
      await tester.tap(find.text(_kDoorUpload), warnIfMissed: false);
      await tester.pump();
      importer.complete();
      await tester.pumpAndSettle();

      expect(importer.calls, 1);
    });

    testWidgets('door 2 is inert while an upload is in flight', (
      WidgetTester tester,
    ) async {
      final _CountingImporter importer = _CountingImporter();
      final GoRouter router = await _pump(
        tester,
        picker: _FakePicker(_picked()),
        importer: importer,
      );

      await tester.tap(find.text(_kDoorUpload));
      await tester.pump();
      await tester.tap(find.text(_kDoorChat), warnIfMissed: false);
      await tester.pump();

      // Still here: a half-registered import must not be left behind him.
      expect(_where(router), Routes.resumeUpload);
      importer.complete();
      await tester.pumpAndSettle();
      expect(_where(router), Routes.chatProfiling);
    });
  });

  group('the chip hint is not a tick — ruling D2 at the widget level', () {
    testWidgets('a suggested chip paints differently from a selected one', (
      WidgetTester tester,
    ) async {
      // Guards the primitive the trade form's suggestions ride on: if these
      // two ever render the same, "highlighted but unticked" stops being a
      // distinction a worker can see.
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: const Scaffold(
            body: Column(
              children: <Widget>[
                BbChip(label: 'plain'),
                BbChip(label: 'hinted', suggested: true),
                BbChip(label: 'chosen', selected: true),
                BbChip(label: 'both', selected: true, suggested: true),
              ],
            ),
          ),
        ),
      );

      Color fillOf(String label) {
        final Container box = tester.widget<Container>(
          find
              .ancestor(of: find.text(label), matching: find.byType(Container))
              .first,
        );
        return ((box.decoration! as BoxDecoration).color)!;
      }

      expect(fillOf('hinted'), isNot(fillOf('plain')));
      expect(fillOf('hinted'), isNot(fillOf('chosen')));
      // Selected always WINS the paint: a chip he actually chose never dims
      // back to a hint.
      expect(fillOf('both'), fillOf('chosen'));
    });
  });
}

/// An importer whose future the test completes by hand, so "in flight" is a
/// state the test can hold the screen in.
class _CountingImporter implements ResumeImporter {
  int calls = 0;
  final List<void Function()> _pending = <void Function()>[];

  void complete() {
    for (final void Function() c in List<void Function()>.of(_pending)) {
      c();
    }
    _pending.clear();
  }

  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument d) {
    calls++;
    final Completer<ResumeImportOutcome> completer =
        Completer<ResumeImportOutcome>();
    _pending.add(() => completer.complete(const ResumeImportRoutedToChat()));
    return completer.future;
  }
}
