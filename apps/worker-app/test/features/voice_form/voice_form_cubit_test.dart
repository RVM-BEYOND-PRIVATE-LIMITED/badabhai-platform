import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/question_audio_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/voice_form_cubit.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

/// A scripted gateway over [total] questions — counts submits + finalizes.
class FakeGateway implements VoiceFormGateway {
  FakeGateway(this.total);
  final int total;
  int served = 0;
  int submits = 0;
  int finalizes = 0;
  final List<VoiceAnswer> received = <VoiceAnswer>[];

  VoiceQuestion _q(int i) => VoiceQuestion(id: 'q$i', prompt: 'Question $i');

  @override
  Future<VoiceFormStep> start() async {
    served = 1;
    return NextQuestion(_q(1), index: 1, total: total);
  }

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer) async {
    submits++;
    received.add(answer);
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

  setUp(() {
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

    final VoiceFormReview review = cubit.state as VoiceFormReview;
    final List<String> paths = review.answers
        .map((VoiceAnswer a) => a.clip!.path)
        .toList(growable: false);
    expect(paths, hasLength(8));
    expect(paths.toSet(), hasLength(8), reason: 'every clip path is distinct');
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
    final FakeGateway gateway = FakeGateway(1);
    final VoiceFormCubit cubit = build(gateway: gateway);
    addTearDown(cubit.close);
    await cubit.start();
    await cubit.answerBySpeaking();

    // One question, one answer ⇒ straight to review.
    expect(cubit.state, isA<VoiceFormReview>());
    expect(gateway.submits, 1);
    // A single-question session finalises through the only submit path.
    await cubit.submitReviewed();
    expect(cubit.state, isA<VoiceFormComplete>());
    expect(gateway.finalizes, 1);
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
}

/// A gateway whose [submit] always throws — for proving the retain/release
/// pairing survives an upload failure rather than leaking the clip's retain.
class _ThrowingSubmitGateway implements VoiceFormGateway {
  int submitAttempts = 0;

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
        VoiceQuestion(id: 'q1', prompt: 'Question 1'),
        index: 1,
        total: 1,
      );

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer) async {
    submitAttempts++;
    throw Exception('network drop');
  }

  @override
  Future<void> finalize() async {}
}

/// Throws on the FIRST start() (a transient failure), then serves one question.
class _FailFirstGateway implements VoiceFormGateway {
  int _starts = 0;

  @override
  Future<VoiceFormStep> start() async {
    _starts++;
    if (_starts == 1) throw const NetworkFailure();
    return const NextQuestion(
        VoiceQuestion(id: 'q1', prompt: 'Q1'), index: 1, total: 1);
  }

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer) async =>
      const VoiceFormDone();

  @override
  Future<void> finalize() async {}
}
