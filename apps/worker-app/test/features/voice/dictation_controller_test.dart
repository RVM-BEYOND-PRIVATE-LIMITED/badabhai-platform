import 'dart:async';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_dictation.dart';
import 'package:badabhai_worker_app/features/voice/presentation/dictation_controller.dart';

/// A hand double for the ON-DEVICE recogniser, driven entirely by the test: it
/// records what it was asked to do and hands back the sinks so a test can push
/// exact partial/final readings and raw mic samples — no platform channel, no
/// timing to race.
class FakeDictation implements SpeechDictation {
  bool ready = true;
  bool listening = false;
  int initCalls = 0;
  int listenCalls = 0;
  int stopCalls = 0;
  String? localeId;

  /// When set, [initialize] waits on it — lets a test stop dictation while the
  /// start leg is still in flight.
  Completer<bool>? initGate;

  /// When set, [listen] waits on it AFTER the mic has gone hot — the real
  /// plugin's start takes hundreds of ms, and disposing inside that window is
  /// what used to strand a running recogniser with no owner.
  Completer<void>? listenGate;

  void Function(DictationResult result)? onResult;
  void Function(double level)? onSoundLevel;

  /// Push one recognition reading, as the recogniser would.
  void hear(String text, {bool isFinal = false}) =>
      onResult!(DictationResult(text, isFinal: isFinal));

  /// Push one raw mic amplitude sample (the plugin's Android RMS scale).
  void sample(double raw) => onSoundLevel!(raw);

  @override
  Future<bool> initialize() async {
    initCalls++;
    if (initGate != null) return initGate!.future;
    return ready;
  }

  @override
  Future<void> listen({
    required void Function(DictationResult result) onResult,
    void Function(double level)? onSoundLevel,
    String? localeId,
  }) async {
    listenCalls++;
    listening = true; // the mic is hot from here
    this.onResult = onResult;
    this.onSoundLevel = onSoundLevel;
    this.localeId = localeId;
    if (listenGate != null) await listenGate!.future;
  }

  @override
  Future<void> stop() async {
    stopCalls++;
    listening = false;
  }

  @override
  Future<void> cancel() async {
    listening = false;
  }

  @override
  bool get isListening => listening;
}

/// The reusable tap-to-talk unit extracted from the chat composer. These are the
/// behaviours that decide whether a worker's dictated words survive: the
/// utterance-boundary commit, the trailing-final latch, and the adaptive noise
/// floor that keeps the "I am hearing you" cue honest in a noisy workshop.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late FakeDictation speech;
  late DictationController controller;
  late List<String> notices;

  setUp(() {
    speech = FakeDictation();
    notices = <String>[];
    controller = DictationController(
      speech: speech,
      onNotice: notices.add,
    );
  });

  tearDown(() => controller.dispose());

  group('start / stop', () {
    test('start raises the wave and listens; stop lowers it and stops the mic',
        () async {
      await controller.start();

      expect(speech.initCalls, 1);
      expect(speech.listenCalls, 1);
      expect(controller.listening, isTrue);
      expect(controller.dictating, isTrue);

      speech.hear('CNC operator', isFinal: true);
      expect(controller.stop(), 'CNC operator');

      expect(controller.listening, isFalse);
      expect(controller.dictating, isFalse);
      expect(speech.stopCalls, 1);
    });

    test('the wave is up BEFORE initialize resolves — the tap feels instant',
        () async {
      speech.initGate = Completer<bool>();
      final Future<void> started = controller.start();

      expect(controller.listening, isTrue,
          reason: 'the cue must not wait on the permission round trip');
      expect(speech.listenCalls, 0);

      speech.initGate!.complete(true);
      await started;
      expect(speech.listenCalls, 1);
    });

    test('a denied mic / no recogniser gives an honest notice and never listens',
        () async {
      speech.ready = false;

      await controller.start();

      expect(speech.listenCalls, 0);
      expect(notices, <String>[const MicPermissionFailure().message]);
      expect(controller.listening, isFalse);
      expect(controller.dictating, isFalse);
    });

    test('a recogniser that throws gives the honest fallback notice', () async {
      speech.initGate = Completer<bool>()..completeError(StateError('boom'));

      await controller.start();

      expect(notices, <String>[kVoiceToTextUnavailable]);
      expect(controller.listening, isFalse);
    });

    test('Stop tapped DURING the start leg cancels it — no orphan mic', () async {
      speech.initGate = Completer<bool>();
      final Future<void> started = controller.start();
      expect(controller.listening, isTrue);

      expect(controller.stop(), isEmpty);
      expect(controller.listening, isFalse);

      speech.initGate!.complete(true);
      await started;

      expect(speech.listenCalls, 0,
          reason: 'the in-flight start must not begin listening after Stop');
      expect(controller.listening, isFalse);
      expect(controller.dictating, isFalse);
    });

    test('a second start while one is live is ignored', () async {
      await controller.start();
      await controller.start();

      expect(speech.listenCalls, 1);
    });

    test('with no recogniser registered at all, start is a silent no-op',
        () async {
      final DictationController bare = DictationController();
      addTearDown(bare.dispose);

      await bare.start();

      expect(bare.listening, isFalse);
      expect(bare.dictating, isFalse);
    });

    test('stopForSend on an idle controller does nothing', () {
      expect(controller.stopForSend(), isEmpty);
      expect(speech.stopCalls, 0);
    });
  });

  group('utterance boundaries', () {
    test('a growing partial is ONE utterance — the words land once', () async {
      await controller.start();

      speech.hear('I am');
      speech.hear('I am a CNC');
      speech.hear('I am a CNC developer');

      expect(controller.stop(), 'I am a CNC developer');
    });

    test(
        'a partial that RESETS mid-listen starts a new utterance — the pre-pause '
        'words survive', () async {
      await controller.start();

      speech.hear('hello');
      speech.hear('I am a CNC developer');

      expect(controller.stop(), 'hello I am a CNC developer');
    });

    test('consecutive finals append instead of overwriting', () async {
      await controller.start();

      speech.hear('hello', isFinal: true);
      speech.hear('I am a CLC programmer', isFinal: true);

      expect(controller.stop(), 'hello I am a CLC programmer');
    });

    test('a final following its own partials lands once, not twice', () async {
      await controller.start();

      speech.hear('mai');
      speech.hear('mai welder');
      speech.hear('mai welder hoon', isFinal: true);

      expect(controller.stop(), 'mai welder hoon');
    });

    test('text already typed is preserved — recognised words append to it',
        () async {
      await controller.start(initialText: 'Mera naam   ');

      speech.hear('welder hai', isFinal: true);

      expect(controller.stop(), 'Mera naam welder hai');
    });

    test('an empty reading is ignored', () async {
      await controller.start();

      speech.hear('   ');
      speech.hear('kaam', isFinal: true);

      expect(controller.stop(), 'kaam');
    });

    test('the locale id is forwarded to the recogniser', () async {
      await controller.start(localeId: 'hi_IN');

      expect(speech.localeId, 'hi_IN');
    });
  });

  group('the trailing-final latch', () {
    // The recogniser can flush one last final ASYNCHRONOUSLY after the worker
    // stopped. It must never re-fill a box they have just cleared or sent —
    // without the latch the composer refills behind their back.
    test('a final delivered AFTER stop is ignored', () async {
      await controller.start();
      speech.hear('pehla', isFinal: true);
      expect(controller.stop(), 'pehla');

      speech.hear('doosra', isFinal: true);

      expect(controller.text, isEmpty,
          reason: 'a post-stop final must not be accumulated');
    });

    test('a final delivered AFTER a send-from-dictation is ignored', () async {
      await controller.start();
      speech.hear('pehla', isFinal: true);
      expect(controller.stopForSend(), 'pehla');

      speech.hear('doosra', isFinal: true);

      expect(controller.text, isEmpty);
    });

    test('discard drops the carry-over so the next final cannot refill it',
        () async {
      await controller.start();
      speech.hear('bheja hua', isFinal: true);

      controller.discard();
      speech.hear('trailing', isFinal: true);

      expect(controller.text, isEmpty);
    });
  });

  group('the adaptive noise floor', () {
    // These workers are in noisy places (a workshop fan, a roadside, a factory
    // floor). The waveform is only a useful "I am hearing you" cue if ambient
    // noise stays FLAT and only the voice moves the bars, so the exact arithmetic
    // is behaviour, not decoration: seed ABOVE the first sample, drop fast toward
    // a quieter ambient (50/50), rise slowly toward a louder one (90/10), then
    // subtract a 1.5 squelch and normalize over a 6.0 span.

    test('a cold first sample does NOT slam the bars', () async {
      await controller.start();

      speech.sample(5); // seeds the floor at 5 + 6 = 11
      expect(controller.level.value, 0.0);

      speech.sample(12); // loud, but the floor has not settled yet
      expect(controller.level.value, 0.0);
    });

    test('a steady room tone stays flat; a louder voice drives the bars',
        () async {
      await controller.start();

      // A fan at 5.0: the floor halves its gap each sample (5 + 6/2^k), so after
      // eleven samples it is 5.005859375 — and the fan never clears the squelch.
      for (int i = 0; i < 11; i++) {
        speech.sample(5);
        expect(controller.level.value, 0.0);
      }

      // Speech at 12.0: the floor rises only 10% toward it (5.7052734375), so the
      // signal is 12 - 5.7052734375 - 1.5 = 4.7947265625 over the 6.0 span.
      speech.sample(12);
      expect(controller.level.value, closeTo(0.79912109375, 0.0005));
    });

    test('a very loud sample clamps at 1.0', () async {
      await controller.start();

      for (int i = 0; i < 11; i++) {
        speech.sample(5);
      }
      speech.sample(100);

      expect(controller.level.value, 1.0);
    });

    test('stopping parks the level at rest', () async {
      await controller.start();
      for (int i = 0; i < 11; i++) {
        speech.sample(5);
      }
      speech.sample(12);
      expect(controller.level.value, greaterThan(0));

      controller.stop();

      expect(controller.level.value, 0.0);
    });

    test('the floor RESEEDS on the next dictation', () async {
      await controller.start();
      for (int i = 0; i < 11; i++) {
        speech.sample(5);
      }
      speech.sample(12);
      controller.stop();

      // A fresh session in a quiet room: 12 is now the ambient, not speech.
      await controller.start();
      speech.sample(12);

      expect(controller.level.value, 0.0,
          reason: 'a carried-over floor would read the new ambient as speech');
    });
  });

  /// A HOT MIC MUST NOT OUTLIVE ITS SCREEN.
  ///
  /// Backing out mid-dictation used to leave the device recogniser running with
  /// no owner: the controller was gone, nothing could ever stop it, and the only
  /// cue the worker had — the waveform — went with the screen. Tolerable-looking
  /// on one screen; not something to replicate onto a second one.
  ///
  /// These build their OWN controller because the suite's tearDown disposes the
  /// shared one, and a ChangeNotifier disposed twice asserts.
  group('dispose', () {
    test('disposing mid-dictation STOPS the device recogniser', () async {
      final FakeDictation own = FakeDictation();
      final DictationController owned = DictationController(speech: own);
      await owned.start();
      expect(own.listening, isTrue);

      owned.dispose();
      await Future<void>.delayed(Duration.zero);

      expect(own.stopCalls, 1);
      expect(own.listening, isFalse);
    });

    test('disposing when nothing was listening asks the recogniser for nothing',
        () async {
      final FakeDictation own = FakeDictation();
      DictationController(speech: own).dispose();
      await Future<void>.delayed(Duration.zero);

      expect(own.stopCalls, 0);
    });

    test('disposing INSIDE the listen() await still stops the mic', () async {
      // The mic goes hot inside `listen()`. Bailing out of the continuation on
      // `_disposed` before recording that left `dispose`'s `if (_dictating)`
      // false, so nothing ever stopped it — and the impl's restart loop re-arms
      // on every idle timeout, so it stayed hot for the life of the process with
      // no controller left that could stop it and no cue to the worker.
      final FakeDictation own = FakeDictation();
      final DictationController owned = DictationController(speech: own);
      own.listenGate = Completer<void>();

      final Future<void> starting = owned.start();
      await Future<void>.delayed(Duration.zero);
      owned.dispose(); // back arrow before the recogniser finished starting
      own.listenGate!.complete();
      await starting;
      await Future<void>.delayed(Duration.zero);

      expect(own.stopCalls, 1, reason: 'the mic must not outlive the screen');
      expect(own.listening, isFalse);
    });

    test('an amplitude sample after dispose is dropped, not thrown', () async {
      // The shared singleton still holds the disposed controller's sound-level
      // closure until another controller rebinds it, so a sample can land after
      // `_level` was disposed. Writing it threw a red screen in debug/profile.
      final FakeDictation own = FakeDictation();
      final DictationController owned = DictationController(speech: own);
      await owned.start();
      for (int i = 0; i < 11; i++) {
        own.sample(5.0);
      }
      owned.dispose();

      expect(() => own.sample(12.0), returnsNormally);
    });
  });

  /// ONE recogniser, TWO surfaces. [SpeechDictation] is a registered lazy
  /// SINGLETON with a single result sink, and the floating Feedback button can
  /// stack the feedback screen on top of a chat that is mid-dictation. Measured
  /// before ownership existed: the interview answer was delivered into the
  /// feedback box and POSTed as the worker's report, and backing out of feedback
  /// then stopped the mic under a chat still painting a waveform.
  group('two surfaces, one shared recogniser', () {
    test('a takeover stands the previous owner down and returns its words',
        () async {
      final FakeDictation shared = FakeDictation();
      final List<String> chatLanded = <String>[];
      final DictationController chat = DictationController(
        speech: shared,
        onInterrupted: chatLanded.add,
      );
      final DictationController feedback = DictationController(speech: shared);
      addTearDown(chat.dispose);
      addTearDown(feedback.dispose);

      await chat.start();
      shared.hear('mera naam Ramesh hai');
      await feedback.start();

      // The chat screen is told, and gets its words back to land in its field.
      expect(chatLanded, <String>['mera naam Ramesh hai']);
      expect(chat.listening, isFalse,
          reason: 'no waveform over a mic it no longer drives');
      expect(chat.dictating, isFalse);
      // The old session is ENDED before the new one starts, so the in-flight
      // utterance cannot keep streaming into the newcomer's field.
      expect(shared.stopCalls, 1);
      expect(feedback.text, isEmpty);
    });

    test('disposing the new owner does not reach across to the old controller',
        () async {
      final FakeDictation shared = FakeDictation();
      final DictationController chat = DictationController(speech: shared);
      final DictationController feedback = DictationController(speech: shared);
      addTearDown(chat.dispose);

      await chat.start();
      await feedback.start();
      final int stopsBefore = shared.stopCalls;
      feedback.dispose(); // worker pops back to chat
      await Future<void>.delayed(Duration.zero);

      // Feedback owned the session, so stopping it is correct — what must NOT
      // happen is chat being left as a live-looking waveform over a dead mic.
      expect(shared.stopCalls, stopsBefore + 1);
      expect(chat.listening, isFalse);
      expect(chat.dictating, isFalse);
    });

    test('a stood-down controller never stops the session it no longer owns',
        () async {
      final FakeDictation shared = FakeDictation();
      final DictationController chat = DictationController(speech: shared);
      final DictationController feedback = DictationController(speech: shared);
      addTearDown(feedback.dispose);

      await chat.start();
      await feedback.start();
      final int stopsBefore = shared.stopCalls;

      chat.dispose(); // the chat screen is finally popped
      await Future<void>.delayed(Duration.zero);

      expect(shared.stopCalls, stopsBefore,
          reason: 'feedback is still dictating — its mic must survive');
      expect(shared.listening, isTrue);
    });
  });

  /// Nothing else stops the mic when the app leaves the foreground: the impl's
  /// restart loop is gated only on its own want-listening flag, so the platform
  /// idle timeout re-acquires the mic on a loop with the waveform — the worker's
  /// only cue — off screen.
  group('app lifecycle', () {
    test('backgrounding stops the mic and hands back the words', () async {
      final FakeDictation own = FakeDictation();
      final List<String> landed = <String>[];
      final DictationController owned =
          DictationController(speech: own, onInterrupted: landed.add);
      addTearDown(owned.dispose);

      await owned.start();
      own.hear('mera naam Ramesh hai', isFinal: true);
      owned.didChangeAppLifecycleState(AppLifecycleState.paused);
      await Future<void>.delayed(Duration.zero);

      expect(own.stopCalls, 1);
      expect(own.listening, isFalse);
      expect(owned.listening, isFalse);
      expect(landed, <String>['mera naam Ramesh hai']);
    });

    test('resuming does not stop a live session', () async {
      final FakeDictation own = FakeDictation();
      final DictationController owned = DictationController(speech: own);
      addTearDown(owned.dispose);

      await owned.start();
      owned.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await Future<void>.delayed(Duration.zero);

      expect(own.stopCalls, 0);
      expect(own.listening, isTrue);
    });
  });
}
