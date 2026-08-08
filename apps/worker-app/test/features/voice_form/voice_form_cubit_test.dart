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
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/voice_form_cubit.dart';
import 'voice_form_doubles.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

/// A scripted gateway over [total] questions — counts submits + finalizes.
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
}
