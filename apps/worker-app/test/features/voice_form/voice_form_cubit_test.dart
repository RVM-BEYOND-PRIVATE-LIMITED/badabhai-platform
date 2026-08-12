import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/question_audio_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_correction_outcome.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_review_row.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/voice_form_cubit.dart';
import 'voice_form_doubles.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

/// A scripted gateway over [total] questions — counts submits + finalizes, and
/// serves review rows + corrections for the #700 client-half tests.
class FakeGateway implements VoiceFormGateway {
  @override
  String? get sessionId => 'sess-test';

  FakeGateway(this.total);
  final int total;
  int served = 0;
  int submits = 0;
  int finalizes = 0;
  final List<VoiceAnswer> received = <VoiceAnswer>[];
  /// The stale-answer guard the CUBIT asserted for each submit (#717).
  final List<String?> questionKeys = <String?>[];

  // --- #700 correction surface ---------------------------------------------
  /// Rows served on entering review; a null [reviewRowsFailure] means success.
  List<VoiceReviewRow> reviewRowsResult = const <VoiceReviewRow>[];
  Failure? reviewRowsFailure;

  /// What `correct()` records + returns (or throws).
  final List<VoiceAnswer> corrected = <VoiceAnswer>[];
  final List<String> correctedKeys = <String>[];
  VoiceCorrectionOutcome? correctResult;
  Failure? correctFailure;

  VoiceQuestion _q(int i) => VoiceQuestion(id: 'q$i', prompt: 'Question $i');

  @override
  Future<VoiceFormStep> start() async {
    served = 1;
    return NextQuestion(_q(1), index: 1, total: total);
  }

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async {
    submits++;
    received.add(answer);
    questionKeys.add(questionKey);
    if (served >= total) return const VoiceFormDone();
    served++;
    return NextQuestion(_q(served), index: served, total: total);
  }

  @override
  Future<void> finalize() async => finalizes++;

  @override
  Future<List<VoiceReviewRow>> reviewRows() async {
    final Failure? failure = reviewRowsFailure;
    if (failure != null) throw failure;
    return reviewRowsResult;
  }

  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) async {
    corrected.add(answer);
    correctedKeys.add(questionKey);
    final Failure? failure = correctFailure;
    if (failure != null) throw failure;
    return correctResult ??
        const VoiceCorrectionOutcome(
          questionId: 'q1',
          displayValue: 'x',
          declined: false,
          correctionCount: 1,
          profileRebuildRequired: false,
        );
  }

  @override
  Future<Set<String>> answeredQuestionKeys() async => const <String>{};
}

class FakeTts implements QuestionAudioPlayer {
  int plays = 0;
  int stops = 0;
  @override
  Future<void> play(VoiceQuestion question) async => plays++;
  @override
  Future<void> stop() async => stops++;
}

class MockTts extends Mock implements QuestionAudioPlayer {}

void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
    registerFallbackValue(Duration.zero);
    registerFallbackValue(const VoiceQuestion(id: 'x', prompt: 'x'));
  });

  late MockAudioRecorder plugin;
  late StreamController<Amplitude> amp;
  late int stopN;

  late FakeRegistrar registrar;

  setUp(() {
    registrar = FakeRegistrar();
    plugin = MockAudioRecorder();
    amp = StreamController<Amplitude>.broadcast();
    stopN = 0;
    when(() => plugin.hasPermission()).thenAnswer((_) async => true);
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => plugin.cancel()).thenAnswer((_) async {});
    when(() => plugin.dispose()).thenAnswer((_) async {});
    when(() => plugin.onAmplitudeChanged(any())).thenAnswer((_) => amp.stream);
    when(() => plugin.onStateChanged())
        .thenAnswer((_) => const Stream<RecordState>.empty());
    // Each stop yields a DISTINCT clip path.
    when(() => plugin.stop())
        .thenAnswer((_) async => 'clip-${stopN++}.m4a');
  });

  tearDown(() => amp.close());

  VoiceFormCubit build({VoiceFormGateway? gateway, FakeTts? tts}) =>
      VoiceFormCubit(
        gateway: gateway ?? FakeGateway(8),
        recorder: SessionVoiceRecorder(recorder: plugin),
        endpointer: SilenceEndpointer(),
        tts: tts ?? FakeTts(),
        registrar: registrar,
        session: testSession(),
        sleep: (_) async {}, // no-op prime delay
      );

  /// Drive the whole 8-question session by speaking each answer.
  Future<VoiceFormCubit> runFullSession(FakeGateway gateway) async {
    final VoiceFormCubit cubit = build(gateway: gateway);
    await cubit.start();
    expect(cubit.state, isA<VoiceFormAsking>());
    for (int i = 0; i < gateway.total; i++) {
      await cubit.answerBySpeaking();
    }
    return cubit;
  }

  test('permission is requested exactly once across 8 questions', () async {
    final FakeGateway gateway = FakeGateway(8);
    final VoiceFormCubit cubit = await runFullSession(gateway);
    addTearDown(cubit.close);

    expect(cubit.state, isA<VoiceFormReview>());
    verify(() => plugin.hasPermission()).called(1);
  });

  test('8 advances yield 8 distinct clip paths', () async {
    final FakeGateway gateway = FakeGateway(8);
    final VoiceFormCubit cubit = await runFullSession(gateway);
    addTearDown(cubit.close);

    // ASSERTED ON THE REGISTRAR, because that is where a clip goes now (#717): the cubit
    // uploads it and the answer carries only the resulting `voice_note_id`. The property is
    // unchanged — every advance recorded and uploaded its OWN take, never re-sending the
    // previous one — it is just observed one seam earlier.
    final List<String> paths = registrar.registered
        .map((RecordedClip c) => c.path)
        .toList(growable: false);
    expect(paths, hasLength(8));
    expect(paths.toSet(), hasLength(8), reason: 'every clip path is distinct');

    // …and each of those uploads became one spoken answer.
    final VoiceFormReview review = cubit.state as VoiceFormReview;
    expect(review.answers.where((VoiceAnswer a) => a.isSpoken), hasLength(8));
    expect(review.answers.every((VoiceAnswer a) => a.voiceNoteId != null), isTrue);
  });

  test('the recorder is never disposed mid-session; disposed exactly once on '
      'close', () async {
    final FakeGateway gateway = FakeGateway(8);
    final VoiceFormCubit cubit = await runFullSession(gateway);
    verifyNever(() => plugin.dispose()); // untouched through the whole session

    await cubit.close();
    verify(() => plugin.dispose()).called(1);
  });

  test('advance is idempotent — a double trigger fires ONE submit + ONE stop',
      () async {
    final FakeGateway gateway = FakeGateway(8);
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);
    await cubit.start();

    // Fire two advances for the SAME question before the first settles.
    final Future<void> a = cubit.answerBySpeaking();
    final Future<void> b = cubit.answerBySpeaking();
    await Future.wait(<Future<void>>[a, b]);

    expect(gateway.submits, 1, reason: 'the second trigger is a no-op');
    verify(() => plugin.stop()).called(1);
  });

  test('a spoken answer retains its clip before submit and releases it after',
      () async {
    // NAMED FOR THE RETAIN, SO IT HAD BETTER MEASURE IT. It asserted only that a
    // one-question session reaches review and finalizes — it passed unchanged with BOTH
    // `_recorder.retain(...)` and the release deleted, which is exactly the pairing this
    // change restructured. The retain is observed mid-flight (a gateway that parks inside
    // `submit`), and the release after.
    final Completer<VoiceFormStep> hold = Completer<VoiceFormStep>();
    final _HoldingGateway gateway = _HoldingGateway(hold);
    final SessionVoiceRecorder recorder = SessionVoiceRecorder(recorder: plugin);
    final VoiceFormCubit cubit = VoiceFormCubit(
      gateway: gateway,
      recorder: recorder,
      endpointer: SilenceEndpointer(),
      tts: FakeTts(),
      registrar: registrar,
      session: testSession(),
      sleep: (_) async {},
    );
    addTearDown(cubit.close);
    await cubit.start();

    final Future<void> advancing = cubit.answerBySpeaking();
    await pumpEventQueue();
    // Parked inside submit: the clip is PROTECTED from the stale-clip sweep.
    expect(recorder.retainedPaths, hasLength(1));

    hold.complete(const VoiceFormDone());
    await advancing;

    // Resolved: the protection is dropped, or the sweep can never reclaim it.
    expect(recorder.retainedPaths, isEmpty);
    expect(cubit.state, isA<VoiceFormReview>());
    expect(gateway.submits, 1);
    await cubit.submitReviewed();
    expect(cubit.state, isA<VoiceFormComplete>());
    expect(gateway.finalizes, 1);
  });

  test('the question_key sent is the one ON SCREEN, not one the gateway inferred (#717)',
      () async {
    // The stale-answer guard is a plain equality test server-side, so a client that sends
    // the WRONG key gets a PASS and the answer is captured against the wrong question. The
    // gateway used to derive the key as a side effect of parsing a step — which desyncs the
    // moment the cubit discards a step (an interruption during submit). Only the cubit knows
    // what the worker is looking at, so the cubit states it.
    final FakeGateway gateway = FakeGateway(3);
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);

    await cubit.start(); // Q1 on screen
    await cubit.answerBySpeaking();
    await cubit.answerBySpeaking(); // Q2 on screen

    expect(gateway.questionKeys, <String?>['q1', 'q2'],
        reason: 'each answer names the question it was an answer TO');
  });

  test('a denied mic → VoiceFormError, no session', () async {
    when(() => plugin.hasPermission()).thenAnswer((_) async => false);
    final FakeGateway gateway = FakeGateway(8);
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);
    await cubit.start();

    expect(cubit.state, isA<VoiceFormError>());
    expect(gateway.submits, 0);
    verifyNever(() => plugin.start(any(), path: any(named: 'path')));
  });

  test('a chip answer submits option_keys and makes NO STT call (#630)',
      () async {
    final FakeGateway gateway = FakeGateway(2);
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);
    await cubit.start();
    clearInteractions(plugin);

    await cubit.answerByChips(<String>['night']);

    expect(gateway.received.single.kind, VoiceAnswerKind.chips);
    expect(gateway.received.single.optionKeys, <String>['night']);
    // No STT: the clip is discarded (cancel), never stopped-and-uploaded.
    verifyNever(() => plugin.stop());
    verify(() => plugin.cancel()).called(1);
  });

  test('a boolean answer is one tap; a multi-select submits N keys (#630)',
      () async {
    final FakeGateway gateway = FakeGateway(3);
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);
    await cubit.start();

    await cubit.answerByBoolean(true);
    await cubit.answerByChips(<String>['welding', 'fitting']);
    await cubit.answerByText('Nahi pata');

    expect(gateway.received[0].kind, VoiceAnswerKind.boolean);
    expect(gateway.received[0].boolValue, isTrue);
    expect(gateway.received[1].optionKeys, <String>['welding', 'fitting']);
    expect(gateway.received[2].kind, VoiceAnswerKind.text);
    expect(gateway.received[2].text, 'Nahi pata');
  });

  test('replay() stops the mic for the WHOLE of playback, then re-arms (#631)',
      () async {
    final MockTts tts = MockTts();
    when(() => tts.play(any())).thenAnswer((_) async {});
    when(() => tts.stop()).thenAnswer((_) async {});

    final VoiceFormCubit cubit = VoiceFormCubit(
      gateway: FakeGateway(8),
      recorder: SessionVoiceRecorder(recorder: plugin),
      endpointer: SilenceEndpointer(),
      tts: tts,
      registrar: registrar,
      session: testSession(),
      sleep: (_) async {},
    );
    addTearDown(cubit.close);
    await cubit.start(); // Q1 presented, mic armed
    clearInteractions(plugin);

    await cubit.replay();

    // PROMPTING and LISTENING are mutually exclusive: the mic is cancelled
    // BEFORE playback and only re-started AFTER it completes.
    verifyInOrder(<void Function()>[
      () => plugin.cancel(),
      () => tts.play(any()),
      () => plugin.start(any(), path: any(named: 'path')),
    ]);
  });

  test(
      'REGRESSION: close() racing replay()\'s cancel() does not throw an '
      'uncaught StateError out of emit() (#662 fix)', () async {
    final Completer<void> cancelEntered = Completer<void>();
    final Completer<void> cancelBlock = Completer<void>();

    final VoiceFormCubit cubit = build(gateway: FakeGateway(8));
    await cubit.start(); // Q1 presented, mic armed

    // Only now make cancel() hang, so start()'s own internals are unaffected.
    when(() => plugin.cancel()).thenAnswer((_) async {
      if (!cancelEntered.isCompleted) cancelEntered.complete();
      await cancelBlock.future; // hang inside replay()'s cancel() await
    });

    final Future<void> replaying = cubit.replay();
    await cancelEntered.future;

    // Tear down mid-replay. Before the fix the continuation ran straight into
    // emit() on a closed bloc — an uncaught StateError escaping this
    // unawaited Future, which the test zone turns into a failure.
    final Future<void> closing = cubit.close();
    cancelBlock.complete();

    await Future.wait(<Future<void>>[replaying, closing]);
    // Reaching here at all is the assertion: no uncaught StateError escaped.
  });

  test(
      'REGRESSION: close() racing the permission await does not take a levels '
      'subscription close() has already cancelled', () async {
    final Completer<void> permEntered = Completer<void>();
    final Completer<bool> permBlock = Completer<bool>();
    when(() => plugin.hasPermission()).thenAnswer((_) {
      if (!permEntered.isCompleted) permEntered.complete();
      return permBlock.future; // hang inside start()'s permission await
    });

    final VoiceFormCubit cubit = build(gateway: FakeGateway(8));
    final Future<void> starting = cubit.start();
    await permEntered.future;

    // close() runs its whole teardown (cancel _levelsSub, close _meter,
    // dispose the recorder) while start() is parked. Guarding on isClosed
    // would let the continuation resume and subscribe to a disposed
    // recorder's amplitude stream — a subscription nothing will ever cancel.
    final Future<void> closing = cubit.close();
    permBlock.complete(true);

    await Future.wait(<Future<void>>[starting, closing]);

    verifyNever(() => plugin.onAmplitudeChanged(any()));
    verifyNever(() => plugin.start(any(), path: any(named: 'path')));
  });

  test(
      'REGRESSION: close() racing an empty-clip re-arm does not restart the '
      'mic after teardown', () async {
    final Completer<void> stopEntered = Completer<void>();
    final Completer<String?> stopBlock = Completer<String?>();

    final VoiceFormCubit cubit = build(gateway: FakeGateway(8));
    await cubit.start();
    clearInteractions(plugin);

    // A mis-trigger: stop() yields no clip, so _advance re-arms the SAME
    // question — a mic start on a path distinct from replay()/reRecord().
    when(() => plugin.stop()).thenAnswer((_) {
      if (!stopEntered.isCompleted) stopEntered.complete();
      return stopBlock.future;
    });

    final Future<void> advancing = cubit.answerBySpeaking();
    await stopEntered.future;

    final Future<void> closing = cubit.close();
    stopBlock.complete(null); // no clip captured

    await Future.wait(<Future<void>>[advancing, closing]);

    verifyNever(() => plugin.start(any(), path: any(named: 'path')));
  });

  test(
      'REGRESSION: close() racing reRecord()\'s cancel() does not re-arm the '
      'mic after teardown (#629)', () async {
    final Completer<void> cancelEntered = Completer<void>();
    final Completer<void> cancelBlock = Completer<void>();

    final VoiceFormCubit cubit = build(gateway: FakeGateway(8));
    await cubit.start(); // Q1 presented, mic armed
    clearInteractions(plugin);

    when(() => plugin.cancel()).thenAnswer((_) async {
      if (!cancelEntered.isCompleted) cancelEntered.complete();
      await cancelBlock.future; // hang inside reRecord()'s cancel() await
    });

    final Future<void> reRecording = cubit.reRecord();
    await cancelEntered.future;

    // Tear down mid-reRecord. Without the isClosed guard the continuation
    // re-armed a recorder close() had already disposed — starting the mic
    // again AFTER teardown.
    final Future<void> closing = cubit.close();
    cancelBlock.complete();

    await Future.wait(<Future<void>>[reRecording, closing]);

    verifyNever(() => plugin.start(any(), path: any(named: 'path')));
  });

  test('close() inside the start() await window still releases the mic',
      () async {
    final Completer<void> startEntered = Completer<void>();
    final Completer<void> startBlock = Completer<void>();
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {
      if (!startEntered.isCompleted) startEntered.complete();
      await startBlock.future; // hang inside the start() await window
    });

    final VoiceFormCubit cubit = build(gateway: FakeGateway(8));
    unawaited(cubit.start());
    await startEntered.future; // now suspended on recorder.start()

    await cubit.close();
    verify(() => plugin.cancel()).called(greaterThanOrEqualTo(1));
    verify(() => plugin.dispose()).called(1);
  });

  test(
      'REGRESSION: close() racing _advance()\'s stop() does not throw an '
      'uncaught StateError out of emit() (#660 fix)', () async {
    final Completer<void> stopEntered = Completer<void>();
    final Completer<void> stopBlock = Completer<void>();
    when(() => plugin.stop()).thenAnswer((_) async {
      if (!stopEntered.isCompleted) stopEntered.complete();
      await stopBlock.future; // hang inside _advance()'s stop() await
      return 'clip-0.m4a';
    });

    final VoiceFormCubit cubit = build(gateway: FakeGateway(8));
    await cubit.start();
    expect(cubit.state, isA<VoiceFormAsking>());

    // Fire the answer but don't await it yet — it suspends on stop().
    final Future<void> advancing = cubit.answerBySpeaking();
    await stopEntered.future;

    // Tear the screen down WHILE _advance() is mid-flight. Before the fix,
    // letting stopBlock complete now drives _advance() straight into an
    // `emit()` on a closed bloc — an uncaught StateError propagating out of
    // this unawaited Future is exactly the failure Flutter's test zone would
    // catch and fail this test with.
    final Future<void> closing = cubit.close();
    stopBlock.complete();

    await Future.wait(<Future<void>>[advancing, closing]);
    // Reaching here at all is the assertion: no uncaught StateError escaped.
  });

  test(
      'REGRESSION: a submit() that throws leaves VoiceFormCubit in a clean '
      'error state, not silently stuck (#660 fix)', () async {
    final _ThrowingSubmitGateway gateway = _ThrowingSubmitGateway();
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);
    await cubit.start();
    expect(cubit.state, isA<VoiceFormAsking>());

    await cubit.answerBySpeaking();

    expect(cubit.state, isA<VoiceFormError>());
    expect(gateway.submitAttempts, 1);
  });

  test(
      'reset() recovers Error->Idle; re-start neither re-asks permission nor '
      'leaks a second subscription (#680.5)', () async {
    final _FailFirstGateway gateway = _FailFirstGateway();
    final VoiceFormCubit cubit = VoiceFormCubit(
      gateway: gateway,
      recorder: SessionVoiceRecorder(recorder: plugin),
      endpointer: SilenceEndpointer(),
      tts: FakeTts(),
      registrar: registrar,
      session: testSession(),
      sleep: (_) async {},
    );
    addTearDown(cubit.close);

    await cubit.start(); // gateway.start() throws → Error
    expect(cubit.state, isA<VoiceFormError>());

    cubit.reset();
    expect(cubit.state, isA<VoiceFormIdle>());

    await cubit.start(); // now succeeds
    expect(cubit.state, isA<VoiceFormAsking>());

    // Permission asked ONCE across both starts; the mic subscription taken ONCE
    // (the guard), not leaked on the retry.
    verify(() => plugin.hasPermission()).called(1);
    verify(() => plugin.onAmplitudeChanged(any())).called(1);
  });

  group('the spoken answer is uploaded before it is submitted (#717)', () {
    test('the clip is registered against the ENGINE session, and only the id is sent',
        () async {
      final FakeGateway gateway = FakeGateway(8);
      registrar.nextId = 'vn-99';
      final VoiceFormCubit cubit = build(gateway: gateway);
      addTearDown(cubit.close);
      await cubit.start();
      await cubit.answerBySpeaking();

      expect(registrar.registered, hasLength(1));
      // The gateway's session, not the chat one — a profiling session IS a chat_sessions
      // row, and this is the id `POST /voice/upload` is given.
      expect(registrar.sessionIds.single, gateway.sessionId);

      final VoiceAnswer sent = gateway.received.single;
      expect(sent.isSpoken, isTrue);
      expect(sent.voiceNoteId, 'vn-99');
    });

    test('an upload that fails does not submit, and does not leave the clip retained',
        () async {
      // The retain protects an in-flight upload from the stale-clip sweep. Before the
      // release moved to a single `finally`, an upload that threw reached neither the
      // interruption check nor the post-submit release, so the path stayed retained for the
      // life of the (shared, longer-lived) recorder and could never be reclaimed.
      final FakeGateway gateway = FakeGateway(8);
      registrar.throws = const VoiceUnavailableFailure();
      final SessionVoiceRecorder recorder =
          SessionVoiceRecorder(recorder: plugin);
      final VoiceFormCubit cubit = VoiceFormCubit(
        gateway: gateway,
        recorder: recorder,
        endpointer: SilenceEndpointer(),
        tts: FakeTts(),
        registrar: registrar,
        session: testSession(),
        sleep: (_) async {},
      );
      addTearDown(cubit.close);
      await cubit.start();
      await cubit.answerBySpeaking();

      expect(cubit.state, isA<VoiceFormError>());
      expect(gateway.submits, 0, reason: 'nothing to submit — the clip never uploaded');
      expect(recorder.retainedPaths, isEmpty,
          reason: 'a failed upload must still release its retain');
    });
  });

  test('a RETRYABLE step re-asks the SAME question instead of ending the interview (#717)',
      () async {
    // The server marks a lost CAS / failed transcription as "nothing was written, send that
    // again". It used to arrive as a thrown Failure → VoiceFormError, whose only screen
    // action is onExit, so the interview ended on the one outcome that was meant to continue.
    final _RetryOnceGateway gateway = _RetryOnceGateway();
    final FakeTts tts = FakeTts();
    final VoiceFormCubit cubit = build(gateway: gateway, tts: tts);
    addTearDown(cubit.close);

    await cubit.start();
    expect(tts.plays, 1); // Q1 read once
    await cubit.answerBySpeaking(); // → the engine says "send that again"

    expect(cubit.state, isA<VoiceFormAsking>(),
        reason: 'the interview continues; this is not an error');
    final VoiceFormAsking asking = cubit.state as VoiceFormAsking;
    expect(asking.question.id, 'q1', reason: 'the SAME question, not the next one');
    expect(tts.plays, 2, reason: 're-asked aloud — the worker cannot read the screen');

    // The lost answer is not counted, and the mic is live again.
    await cubit.answerBySpeaking();
    expect(gateway.submits, 2);
    expect(cubit.state, isA<VoiceFormAsking>());
    expect((cubit.state as VoiceFormAsking).question.id, 'q2');
  });

  test('a discarded turn is NOT banked as an answer (#717)', () async {
    // The server said it wrote nothing. Appending anyway puts two entries in `_answers` for
    // one question the moment the worker re-answers — publishing a `voice_note_id` for a
    // turn that was thrown away — and over-counts `profiling_answer_spoken` on exactly the
    // flaky-2G path the retryable step exists for.
    final _RetryOnceGateway gateway = _RetryOnceGateway();
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);

    await cubit.start();
    await cubit.answerBySpeaking(); // discarded by the engine
    await cubit.answerBySpeaking(); // the real answer to q1 → q2
    await cubit.answerBySpeaking(); // q2 → done

    expect(cubit.state, isA<VoiceFormReview>());
    final List<VoiceAnswer> answers = (cubit.state as VoiceFormReview).answers;
    expect(answers, hasLength(2),
        reason: 'two questions answered, three submits — the discarded one is not an answer');
    expect(gateway.submits, 3);
  });

  // #761 — the advisory lookahead. On a single-select chip / boolean tap whose
  // key the server predicted, render the predicted question + moved dot-rail
  // immediately, mic UN-armed; the real step reconciles. NEVER banked early,
  // submit key unchanged.
  group('optimistic lookahead (#761)', () {
    test('a chip tap renders the predicted question + dot-rail with the mic '
        'UN-armed, then arms on the agreeing real step', () async {
      final Completer<VoiceFormStep> gate = Completer<VoiceFormStep>();
      final _LookaheadGateway gateway = _LookaheadGateway(gate);
      final VoiceFormCubit cubit = build(gateway: gateway);
      addTearDown(cubit.close);
      await cubit.start();
      expect((cubit.state as VoiceFormAsking).question.id, 'q1');
      clearInteractions(plugin);

      // Tap option 'a' — the submit is HELD so the optimistic render is visible.
      final Future<void> advancing = cubit.answerByChips(<String>['a']);
      await pumpEventQueue();

      expect(gate.isCompleted, isFalse);
      final VoiceFormAsking optimistic = cubit.state as VoiceFormAsking;
      expect(optimistic.question.id, 'q2-pred',
          reason: 'the predicted question is on screen already');
      expect(optimistic.index, 2, reason: 'the dot-rail moved on the tap');
      expect(optimistic.total, 8);
      expect(optimistic.micPhase, MicPhase.uploading,
          reason: 'a non-listening phase');
      // The mic must NOT arm on the unconfirmed prediction (#691).
      verifyNever(() => plugin.start(any(), path: any(named: 'path')));
      // The submit names the ANSWERED question, not the prediction — byte-identical.
      expect(gateway.questionKeys, <String?>['q1']);

      // Real step AGREES with the prediction → arm the mic on the confirmed q.
      gate.complete(const NextQuestion(
        VoiceQuestion(id: 'q2-pred', prompt: 'Predicted Q2'),
        index: 2,
        total: 8,
      ));
      await advancing;

      verify(() => plugin.start(any(), path: any(named: 'path'))).called(1);
      expect((cubit.state as VoiceFormAsking).question.id, 'q2-pred');

      // Exactly ONE answer banked for the tap — drive to review to count.
      await cubit.answerBySpeaking(); // answers q2-pred → done
      final VoiceFormReview review = cubit.state as VoiceFormReview;
      expect(review.answers, hasLength(2),
          reason: 'one answer per tap — the prediction never banked early');
      expect(review.answers.first.optionKeys, <String>['a']);
    });

    test('a disagreeing real step REPLACES the optimistic render (still one bank)',
        () async {
      final Completer<VoiceFormStep> gate = Completer<VoiceFormStep>();
      final _LookaheadGateway gateway = _LookaheadGateway(gate);
      final VoiceFormCubit cubit = build(gateway: gateway);
      addTearDown(cubit.close);
      await cubit.start();

      final Future<void> advancing = cubit.answerByChips(<String>['a']);
      await pumpEventQueue();
      expect((cubit.state as VoiceFormAsking).question.id, 'q2-pred');

      // The real step is a DIFFERENT question than predicted.
      gate.complete(const NextQuestion(
        VoiceQuestion(id: 'q_other', prompt: 'Asli agla sawaal'),
        index: 3,
        total: 8,
      ));
      await advancing;
      expect((cubit.state as VoiceFormAsking).question.id, 'q_other',
          reason: 'the real step replaces the optimistic prediction');

      await cubit.answerBySpeaking(); // answers q_other → done
      final VoiceFormReview review = cubit.state as VoiceFormReview;
      expect(review.answers, hasLength(2),
          reason: 'still exactly one answer banked per tap');
      expect(review.answers.first.optionKeys, <String>['a']);
    });

    test('multi-select and spoken taps render NO optimistic prediction (#761)',
        () async {
      // multi-select → 2 keys → no optimistic render.
      final Completer<VoiceFormStep> gate1 = Completer<VoiceFormStep>();
      final VoiceFormCubit c1 = build(gateway: _LookaheadGateway(gate1));
      await c1.start();
      final Future<void> a1 = c1.answerByChips(<String>['a', 'b']);
      await pumpEventQueue();
      expect((c1.state as VoiceFormAsking).question.id, 'q1',
          reason: 'multi-select falls back to today\'s blocking submit');
      gate1.complete(const VoiceFormDone());
      await a1;
      await c1.close();

      // spoken → no prediction possible.
      final Completer<VoiceFormStep> gate2 = Completer<VoiceFormStep>();
      final VoiceFormCubit c2 = build(gateway: _LookaheadGateway(gate2));
      await c2.start();
      final Future<void> a2 = c2.answerBySpeaking();
      await pumpEventQueue();
      expect((c2.state as VoiceFormAsking).question.id, 'q1',
          reason: 'a spoken answer never renders a prediction');
      gate2.complete(const VoiceFormDone());
      await a2;
      await c2.close();
    });
  });
  group('review rows come from server truth (#700)', () {
    test('entering review fetches reviewRows() and populates the rows', () async {
      final FakeGateway gateway = FakeGateway(1);
      gateway.reviewRowsResult = const <VoiceReviewRow>[
        VoiceReviewRow(
            questionId: 'q1', fieldLabel: 'Kaam', displayValue: 'Welder'),
      ];
      final VoiceFormCubit cubit = build(gateway: gateway);
      addTearDown(cubit.close);
      await cubit.start();
      await cubit.answerBySpeaking(); // → done → review

      expect(cubit.state, isA<VoiceFormReview>());
      final VoiceFormReview review = cubit.state as VoiceFormReview;
      expect(review.rows.map((VoiceReviewRow r) => r.displayValue),
          <String>['Welder']);
    });

    test('a reviewRows() failure still enters review with empty rows', () async {
      final FakeGateway gateway = FakeGateway(1);
      gateway.reviewRowsFailure = const VoiceUnavailableFailure();
      final VoiceFormCubit cubit = build(gateway: gateway);
      addTearDown(cubit.close);
      await cubit.start();
      await cubit.answerBySpeaking();

      expect(cubit.state, isA<VoiceFormReview>(),
          reason: 'a rows fetch failure must NOT dead-end into VoiceFormError');
      expect((cubit.state as VoiceFormReview).rows, isEmpty,
          reason: 'the worker can still submit on a degraded review');
    });
  });

  group('a review correction routes through the gateway (#700)', () {
    Future<VoiceFormCubit> toReview(FakeGateway gateway) async {
      final VoiceFormCubit cubit = build(gateway: gateway);
      await cubit.start();
      await cubit.answerBySpeaking(); // → done → review
      expect(cubit.state, isA<VoiceFormReview>());
      return cubit;
    }

    test('correctAnswer posts the questionKey + answer and redraws ONE row',
        () async {
      final FakeGateway gateway = FakeGateway(1);
      gateway.reviewRowsResult = const <VoiceReviewRow>[
        VoiceReviewRow(
            questionId: 'q_city', fieldLabel: 'Sheher', displayValue: 'Puna'),
        VoiceReviewRow(
            questionId: 'q_trade', fieldLabel: 'Kaam', displayValue: 'Welder'),
      ];
      gateway.correctResult = const VoiceCorrectionOutcome(
        questionId: 'q_city',
        displayValue: 'Pune',
        declined: false,
        correctionCount: 1,
        profileRebuildRequired: false,
      );
      final VoiceFormCubit cubit = await toReview(gateway);
      addTearDown(cubit.close);

      await cubit.correctAnswer(const VoiceAnswer.text('Pune'),
          questionKey: 'q_city');

      expect(gateway.correctedKeys, <String>['q_city']);
      expect(gateway.corrected.single.text, 'Pune');
      final VoiceFormReview review = cubit.state as VoiceFormReview;
      expect(
          review.rows
              .firstWhere((VoiceReviewRow r) => r.questionId == 'q_city')
              .displayValue,
          'Pune');
      expect(
          review.rows
              .firstWhere((VoiceReviewRow r) => r.questionId == 'q_trade')
              .displayValue,
          'Welder',
          reason: 'an unaddressed row is untouched');
      expect(review.correctionError, isNull);
    });

    test('a 409/422/cap sets correctionError and STAYS on review, never Error',
        () async {
      final FakeGateway gateway = FakeGateway(1);
      gateway.reviewRowsResult = const <VoiceReviewRow>[
        VoiceReviewRow(
            questionId: 'q_city', fieldLabel: 'Sheher', displayValue: 'Pune'),
      ];
      gateway.correctFailure = const VoiceUnavailableFailure();
      final VoiceFormCubit cubit = await toReview(gateway);
      addTearDown(cubit.close);

      await cubit.correctAnswer(const VoiceAnswer.text('x'),
          questionKey: 'q_city');

      expect(cubit.state, isA<VoiceFormReview>(),
          reason: 'a correction failure keeps the worker on review');
      final VoiceFormReview review = cubit.state as VoiceFormReview;
      expect(review.correctionError, isNotNull);
      expect(review.rows.single.displayValue, 'Pune',
          reason: 'nothing banked on a failed correction');
    });

    test('a spoken correction reuses the first-answer upload path', () async {
      final FakeGateway gateway = FakeGateway(1);
      gateway.reviewRowsResult = const <VoiceReviewRow>[
        VoiceReviewRow(
            questionId: 'q_city', fieldLabel: 'Sheher', displayValue: 'Pune'),
      ];
      final VoiceFormCubit cubit = await toReview(gateway);
      addTearDown(cubit.close);
      registrar.nextId = 'vn-corr-1';

      final String id = await cubit.registerCorrectionClip(
          const RecordedClip(path: 'corr.m4a', durationSeconds: 3));
      await cubit.correctAnswer(VoiceAnswer.spoken(id), questionKey: 'q_city');

      expect(id, 'vn-corr-1');
      expect(registrar.sessionIds, contains(gateway.sessionId));
      final VoiceAnswer sent = gateway.corrected.single;
      expect(sent.isSpoken, isTrue);
      expect(sent.voiceNoteId, 'vn-corr-1');
    });

    test('startCorrectionCapture/stopCorrectionCapture wrap the shared recorder',
        () async {
      final FakeGateway gateway = FakeGateway(1);
      gateway.reviewRowsResult = const <VoiceReviewRow>[
        VoiceReviewRow(
            questionId: 'q_city', fieldLabel: 'Sheher', displayValue: 'Pune'),
      ];
      final VoiceFormCubit cubit = await toReview(gateway);
      addTearDown(cubit.close);
      clearInteractions(plugin);

      await cubit.startCorrectionCapture();
      final RecordedClip? clip = await cubit.stopCorrectionCapture();

      verify(() => plugin.start(any(), path: any(named: 'path'))).called(1);
      verify(() => plugin.stop()).called(1);
      expect(clip, isNotNull, reason: 'the one-shot capture yields a clip to upload');
    });
  });
}

/// Serves Q1, answers the FIRST submit with the retryable step, then behaves normally.
class _RetryOnceGateway implements VoiceFormGateway {
  @override
  String? get sessionId => 'sess-test';

  int submits = 0;

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
        VoiceQuestion(id: 'q1', prompt: 'Question 1'),
        index: 1,
        total: 8,
      );

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async {
    submits++;
    // 1: the engine wrote nothing → re-ask q1. 2: the real answer to q1 → q2. 3: → done, so
    // a test can drive through to review and count what was actually banked.
    if (submits == 1) {
      return const RetryCurrentQuestion('Abhi thodi dikkat aa rahi hai. Dobara bhejiye.');
    }
    if (submits == 2) {
      return const NextQuestion(
        VoiceQuestion(id: 'q2', prompt: 'Question 2'),
        index: 2,
        total: 2,
      );
    }
    return const VoiceFormDone();
  }

  @override
  Future<void> finalize() async {}


  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();

  @override
  Future<List<VoiceReviewRow>> reviewRows() async => const <VoiceReviewRow>[];
  @override
  Future<Set<String>> answeredQuestionKeys() async => const <String>{};
}

/// A gateway whose [submit] always throws — for proving the retain/release
/// pairing survives an upload failure rather than leaking the clip's retain.
class _ThrowingSubmitGateway implements VoiceFormGateway {
  @override
  String? get sessionId => 'sess-test';

  int submitAttempts = 0;

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
        VoiceQuestion(id: 'q1', prompt: 'Question 1'),
        index: 1,
        total: 1,
      );

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async {
    submitAttempts++;
    throw Exception('network drop');
  }

  @override
  Future<void> finalize() async {}


  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();

  @override
  Future<List<VoiceReviewRow>> reviewRows() async => const <VoiceReviewRow>[];
  @override
  Future<Set<String>> answeredQuestionKeys() async => const <String>{};
}

/// Throws on the FIRST start() (a transient failure), then serves one question.
class _FailFirstGateway implements VoiceFormGateway {
  @override
  String? get sessionId => 'sess-test';

  int _starts = 0;

  @override
  Future<VoiceFormStep> start() async {
    _starts++;
    if (_starts == 1) throw const NetworkFailure();
    return const NextQuestion(
        VoiceQuestion(id: 'q1', prompt: 'Q1'), index: 1, total: 1);
  }

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async =>
      const VoiceFormDone();

  @override
  Future<void> finalize() async {}


  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();

  @override
  Future<List<VoiceReviewRow>> reviewRows() async => const <VoiceReviewRow>[];
  @override
  Future<Set<String>> answeredQuestionKeys() async => const <String>{};
}

/// Parks inside `submit` until its completer fires — lets a test observe the retain while
/// the upload/submit leg is genuinely in flight.
class _HoldingGateway implements VoiceFormGateway {
  _HoldingGateway(this._hold);
  final Completer<VoiceFormStep> _hold;
  int submits = 0;
  int finalizes = 0;

  @override
  String? get sessionId => 'sess-test';

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
        VoiceQuestion(id: 'q1', prompt: 'Question 1'),
        index: 1,
        total: 1,
      );

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) {
    submits++;
    return _hold.future;
  }

  @override
  Future<void> finalize() async => finalizes++;


  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) => throw UnimplementedError();

  @override
  Future<List<VoiceReviewRow>> reviewRows() async => const <VoiceReviewRow>[];

  /// Present because `VoiceFormGateway` declares it (#775). This fake does not
  /// exercise the landed-409 confirmation, and an empty set is the "not confirmed"
  /// answer — the safe, under-count direction.
  @override
  Future<Set<String>> answeredQuestionKeys() async => const <String>{};
}

/// Serves a single-select Q1 whose `lookahead` predicts a next question under
/// option 'a' (#761). The FIRST submit is parked on [_firstGate] so a test can
/// observe the optimistic render; later submits return [VoiceFormDone].
class _LookaheadGateway implements VoiceFormGateway {
  _LookaheadGateway(this._firstGate);

  final Completer<VoiceFormStep> _firstGate;
  int submits = 0;
  final List<String?> questionKeys = <String?>[];

  @override
  String? get sessionId => 'sess-test';

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
        VoiceQuestion(
          id: 'q1',
          prompt: 'Question 1',
          kind: VoiceQuestionKind.singleSelect,
          options: <VoiceChoice>[
            VoiceChoice(key: 'a', label: 'A'),
            VoiceChoice(key: 'b', label: 'B'),
          ],
        ),
        index: 1,
        total: 8,
        lookahead: <String, PredictedNext>{
          'a': PredictedNext(
            question: VoiceQuestion(id: 'q2-pred', prompt: 'Predicted Q2'),
            index: 2,
            total: 8,
          ),
        },
      );

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer, {String? questionKey}) async {
    submits++;
    questionKeys.add(questionKey);
    if (submits == 1) return _firstGate.future;
    return const VoiceFormDone();
  }

  @override
  Future<void> finalize() async {}

  /// This fake serves the lookahead path and never reaches the review screen.
  /// Present because `VoiceFormGateway` declares it (#700) and Dart requires every
  /// member of an implemented interface — omitting it is a COMPILE error.
  @override
  Future<List<VoiceReviewRow>> reviewRows() async => const <VoiceReviewRow>[];

  @override
  Future<VoiceCorrectionOutcome> correct(
    VoiceAnswer answer, {
    required String questionKey,
  }) =>
      throw UnimplementedError();
  @override
  Future<Set<String>> answeredQuestionKeys() async => const <String>{};
}
