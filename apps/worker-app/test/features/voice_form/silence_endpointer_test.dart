import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';

void main() {
  // A fake clock the tests advance by hand — the endpointer must never touch a
  // real timer or the recorder plugin.
  late DateTime now;
  DateTime clock() => now;
  void tick(Duration d) => now = now.add(d);

  setUp(() => now = DateTime(2026, 1, 1, 12));

  // Floor default is -50; on-gate = -41, off-gate = -44. LOUD = -20 (speech),
  // QUIET = -60 (silence).
  const double loud = -20;
  const double quiet = -60;

  SilenceEndpointer make({
    EndpointerThresholds thresholds = const EndpointerThresholds(),
    Duration maxAnswer = const Duration(seconds: 30),
  }) =>
      SilenceEndpointer(thresholds: thresholds, maxAnswer: maxAnswer, clock: clock);

  EndpointerSignal feed(SilenceEndpointer ep, double db, {int count = 1, Duration step = const Duration(milliseconds: 100)}) {
    EndpointerSignal sig = EndpointerSignal.none;
    for (int i = 0; i < count; i++) {
      tick(step);
      sig = ep.add(db);
      if (sig != EndpointerSignal.none) break;
    }
    return sig;
  }

  test('calibrate sets the noise floor to the p75 of the sample', () {
    final SilenceEndpointer ep = make();
    ep.calibrate(<double>[-60, -58, -56, -54, -52]); // sorted, p75 idx = 3
    expect(ep.noiseFloorDb, -54);
  });

  test('clean answer: speech past min-speech then trailing silence endpoints',
      () async {
    final SilenceEndpointer ep = make()..arm();
    // 800ms of speech (> 700ms min-speech).
    expect(feed(ep, loud, count: 8), EndpointerSignal.none);
    // Trailing silence past 1400ms → endpoint.
    expect(feed(ep, quiet, count: 20), EndpointerSignal.endpoint);
    expect(ep.phase, EndpointerPhase.done);
  });

  test('a sub-700ms cough is not an answer — no endpoint', () {
    final SilenceEndpointer ep = make()..arm();
    feed(ep, loud, count: 3); // 300ms only
    // Long silence, but there was never real speech → never endpoints.
    for (int i = 0; i < 20; i++) {
      tick(const Duration(milliseconds: 100));
      expect(ep.add(quiet), isNot(EndpointerSignal.endpoint));
    }
  });

  test('an incoming call (stream freezes then resumes) does NOT auto-advance',
      () {
    final SilenceEndpointer ep = make()..arm();
    feed(ep, loud, count: 8); // real speech
    feed(ep, quiet, count: 2); // silence begins (200ms)
    // Call: no samples for 5s (> the 1200ms stall timeout), then one resumes.
    tick(const Duration(seconds: 5));
    final EndpointerSignal sig = ep.add(quiet);
    // The 5s gap is NOT counted as trailing silence — the stall reset guards it.
    expect(sig, isNot(EndpointerSignal.endpoint));
  });

  test('three consecutive cap-outs switch the session to manual-only', () {
    final SilenceEndpointer ep = make(maxAnswer: const Duration(seconds: 1));
    for (int q = 0; q < 3; q++) {
      ep.arm();
      // Keep speaking so it never endpoints — it must cap at 1s.
      final EndpointerSignal sig =
          feed(ep, loud, count: 20, step: const Duration(milliseconds: 200));
      expect(sig, EndpointerSignal.capped);
    }
    expect(ep.manualOnly, isTrue);
    // Once manual-only, a would-be clean answer no longer auto-advances.
    ep.arm();
    expect(feed(ep, quiet, count: 30), EndpointerSignal.none);
  });

  test('a clean endpoint breaks the cap-out streak', () {
    // 3s cap: long enough for a clean answer (800ms speech + 1400ms silence),
    // short enough that speaking non-stop caps out.
    final SilenceEndpointer ep = make(maxAnswer: const Duration(seconds: 3));
    // Two cap-outs (speak non-stop → cap at 3s)...
    for (int q = 0; q < 2; q++) {
      ep.arm();
      expect(feed(ep, loud, count: 40, step: const Duration(milliseconds: 200)),
          EndpointerSignal.capped);
    }
    // ...then a clean answer resets the streak.
    ep.arm();
    feed(ep, loud, count: 5, step: const Duration(milliseconds: 200)); // 1000ms speech
    expect(feed(ep, quiet, count: 8, step: const Duration(milliseconds: 200)),
        EndpointerSignal.endpoint); // >1400ms silence
    // A third cap-out now must NOT trip manual-only (streak was reset to 0→1).
    ep.arm();
    feed(ep, loud, count: 40, step: const Duration(milliseconds: 200));
    expect(ep.manualOnly, isFalse);
  });

  test('thresholds are injectable — a shorter trailingSilence endpoints sooner',
      () {
    final SilenceEndpointer ep = make(
      thresholds: const EndpointerThresholds(
        trailingSilence: Duration(milliseconds: 300),
      ),
    )..arm();
    feed(ep, loud, count: 8); // speech
    // 400ms of silence is enough with the custom 300ms trailing threshold.
    expect(feed(ep, quiet, count: 5), EndpointerSignal.endpoint);
  });

  test(
      'the default cap-out is the RECORDER\'s cap, not a second 30s literal '
      '— retuning one can never silently leave the other behind', () {
    expect(SilenceEndpointer().maxAnswer,
        SessionVoiceRecorder.profilingAnswerMaxDuration);
  });
}
