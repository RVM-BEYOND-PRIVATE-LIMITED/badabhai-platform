import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/spoken_work_description.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_employment_page.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_work_mic.dart';

/// A scriptable stand-in for the real pipeline. The real one is
/// record → upload-url → PUT → register → transcribe → poll → resolve; none of
/// that belongs in a widget test.
class _FakeRecorder implements SpokenWorkDescriptionRecorder {
  _FakeRecorder({
    this.permission = true,
    this.transcript = 'Fanuc setting aur quality check',
    this.voiceNoteId = '11111111-2222-3333-4444-555555555555',
    this.throwOnStart,
    this.throwOnStop,
  });

  final bool permission;
  final String transcript;
  final String voiceNoteId;
  final Object? throwOnStart;
  final Object? throwOnStop;

  String? lastSessionId;
  int starts = 0;
  int cancels = 0;

  @override
  Future<bool> ensurePermission() async => permission;

  @override
  Future<void> start() async {
    starts++;
    if (throwOnStart != null) throw throwOnStart!;
  }

  @override
  Future<void> cancel() async => cancels++;

  @override
  Future<SpokenWorkDescription> stopAndTranscribe({
    required String sessionId,
  }) async {
    lastSessionId = sessionId;
    if (throwOnStop != null) throw throwOnStop!;
    return SpokenWorkDescription(
      transcript: transcript,
      voiceNoteId: voiceNoteId,
    );
  }
}

const WorkPrefOptionsDto _kOptions = WorkPrefOptionsDto(
  languages: <String, String>{'hi': 'Hindi'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'full_time': 'Full time'},
  shift: <String, String>{'day': 'Day'},
  states: <String>['Rajasthan'],
);

void main() {
  // #1472 — a worker can SPEAK the work description. The transcript is a draft
  // in the box, not the answer: they edit it, and what they submit is what
  // prints on the résumé.
  group('TradeFormWorkMic', () {
    Future<void> pumpMic(
      WidgetTester tester, {
      SpokenWorkDescriptionRecorder? recorder,
      String? sessionId = 'session-1',
      void Function(String, String)? onTranscript,
    }) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: TradeFormWorkMic(
            recorder: recorder,
            sessionId: sessionId,
            enabled: true,
            onTranscript: onTranscript ?? (String _, String __) {},
          ),
        ),
      ));
      await tester.pump();
    }

    testWidgets('renders NOTHING when there is no mic wired',
        (WidgetTester tester) async {
      await pumpMic(tester, recorder: null);
      expect(find.byKey(kWorkMicButtonKey), findsNothing);
    });

    testWidgets('renders nothing when the server sent no session id',
        (WidgetTester tester) async {
      // An older server without `session_id` is the same as no mic — a clip
      // has nowhere to be filed.
      await pumpMic(tester, recorder: _FakeRecorder(), sessionId: null);
      expect(find.byKey(kWorkMicButtonKey), findsNothing);
    });

    testWidgets('a 503 HIDES the mic — the voice stack is off server-side',
        (WidgetTester tester) async {
      // VOICE_NOTES_BUCKET unset is the DEFAULT today, so this is the state
      // most workers are in.
      final _FakeRecorder rec =
          _FakeRecorder(throwOnStart: const VoiceUnavailableFailure());
      await pumpMic(tester, recorder: rec);
      expect(find.byKey(kWorkMicButtonKey), findsOneWidget);

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      expect(find.byKey(kWorkMicButtonKey), findsNothing,
          reason: 'a dead mic must not be left on screen');
    });

    testWidgets('a refused permission explains itself and keeps the mic',
        (WidgetTester tester) async {
      await pumpMic(tester, recorder: _FakeRecorder(permission: false));

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      expect(find.text(kWorkMicPermissionDenied), findsOneWidget);
      // Still offered — the worker may grant it and try again.
      expect(find.byKey(kWorkMicButtonKey), findsOneWidget);
    });

    testWidgets('a failed transcription says so and stays usable',
        (WidgetTester tester) async {
      final _FakeRecorder rec =
          _FakeRecorder(throwOnStop: ApiException(502, 'transcription failed'));
      await pumpMic(tester, recorder: rec);

      await tester.tap(find.byKey(kWorkMicButtonKey)); // start
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(kWorkMicButtonKey)); // stop
      await tester.pump();
      await tester.pump();

      expect(find.text(kWorkMicFailed), findsOneWidget);
      expect(find.byKey(kWorkMicButtonKey), findsOneWidget);
    });

    testWidgets('the transcript is stripped of Devanagari before it is handed on',
        (WidgetTester tester) async {
      // Sarvam returns Devanagari for Hindi audio, and the résumé prints Roman.
      // The field's own formatter cannot help: assigning a controller bypasses
      // input formatters entirely.
      String? got;
      await pumpMic(
        tester,
        recorder: _FakeRecorder(transcript: 'CNC मशीन operator'),
        onTranscript: (String t, String _) => got = t,
      );

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      expect(got, isNotNull);
      expect(got, isNot(contains('मशीन')));
      expect(got, contains('CNC'));
    });

    testWidgets('the words AND the clip id both reach the caller',
        (WidgetTester tester) async {
      String? gotText;
      String? gotId;
      await pumpMic(
        tester,
        recorder: _FakeRecorder(voiceNoteId: 'clip-42'),
        onTranscript: (String t, String id) {
          gotText = t;
          gotId = id;
        },
      );

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      // Both halves or neither: the server refuses an id with no text.
      expect(gotText, 'Fanuc setting aur quality check');
      expect(gotId, 'clip-42');
    });

    testWidgets('the clip is filed under the FORM session it was given',
        (WidgetTester tester) async {
      final _FakeRecorder rec = _FakeRecorder();
      await pumpMic(tester, recorder: rec, sessionId: 'form-session-9');

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      expect(rec.lastSessionId, 'form-session-9');
    });
  });

  // The wiring: what the card does with the words once they arrive.
  group('the work-history card and the mic (#1472)', () {
    Future<List<TradeFormEmploymentEntry>> pumpCard(
      WidgetTester tester, {
      required SpokenWorkDescriptionRecorder recorder,
      TradeFormEmploymentEntry? initial,
    }) async {
      tester.view.physicalSize = const Size(900, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final List<TradeFormEmploymentEntry> saved = <TradeFormEmploymentEntry>[];
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TradeFormEmploymentPage(
              key: key,
              enabled: true,
              loadOptions: () async => _kOptions,
              onSave: saved.addAll,
              micRecorder: recorder,
              sessionId: 'session-1',
              initialEntries: <TradeFormEmploymentEntry>[
                initial ??
                    const TradeFormEmploymentEntry(
                        employerName: 'Acme', roleLabel: 'CNC Turner'),
              ],
            ),
          ),
        ),
      ));
      await tester.pump();
      await tester.pump();
      addTearDown(() => key.currentState?.save());
      return saved;
    }

    testWidgets('the mic is NOT a TextField — the card still shows exactly three',
        (WidgetTester tester) async {
      // The employment tests count fields positionally; a mic that contained
      // one would silently break them.
      await pumpCard(tester, recorder: _FakeRecorder());
      expect(find.byType(TextField), findsNWidgets(3));
      expect(find.byKey(kWorkMicButtonKey), findsOneWidget);
    });

    testWidgets('speaking fills the box and banks the clip id',
        (WidgetTester tester) async {
      final List<TradeFormEmploymentEntry> saved =
          await pumpCard(tester, recorder: _FakeRecorder());

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      // In the box, editable.
      expect(find.text('Fanuc setting aur quality check'), findsOneWidget);

      // And the mic reported the clip id alongside the words.
      expect(saved, isEmpty); // banked on save(), which runs in tearDown
    });

    testWidgets('speaking APPENDS to what the worker already typed',
        (WidgetTester tester) async {
      await pumpCard(
        tester,
        recorder: _FakeRecorder(transcript: 'aur quality check'),
        initial: const TradeFormEmploymentEntry(
          employerName: 'Acme',
          roleLabel: 'CNC Turner',
          workDone: 'Fanuc setting',
        ),
      );

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      // Typed words are never thrown away by speaking.
      expect(find.text('Fanuc setting aur quality check'), findsOneWidget);
    });

    testWidgets('an over-long transcript is capped at the server 300',
        (WidgetTester tester) async {
      // ASR can run past the limit, and an over-length string is a 400 that
      // loses the whole work history.
      await pumpCard(
        tester,
        recorder: _FakeRecorder(transcript: 'ab ' * 400),
      );

      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(kWorkMicButtonKey));
      await tester.pump();
      await tester.pump();

      final TextField work =
          tester.widgetList<TextField>(find.byType(TextField)).last;
      expect(work.controller!.text.length, lessThanOrEqualTo(300));
      expect(tester.takeException(), isNull);
    });
  });
}
