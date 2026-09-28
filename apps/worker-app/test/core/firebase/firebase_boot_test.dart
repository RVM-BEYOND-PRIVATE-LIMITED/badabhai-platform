import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/firebase/firebase_boot.dart';

/// The one `Firebase.initializeApp()` the crash reporter and Remote Config share.
void main() {
  setUp(FirebaseBoot.debugReset);
  tearDown(FirebaseBoot.debugReset);

  test('every caller shares ONE attempt, and all of them wait for it', () async {
    final Completer<Object?> boot = Completer<Object?>();
    int boots = 0;
    FirebaseBoot.debugInitializer = () {
      boots++;
      return boot.future;
    };

    int done = 0;
    final Future<void> crash = FirebaseBoot.ensureInitialized().then((_) => done++);
    final Future<void> config = FirebaseBoot.ensureInitialized().then((_) => done++);
    await pumpEventQueue();
    expect(boots, 1);
    expect(done, 0);

    boot.complete(null);
    await Future.wait(<Future<void>>[crash, config]);
    expect(done, 2);

    await FirebaseBoot.ensureInitialized();
    expect(boots, 1, reason: 'a completed boot is not repeated');
  });

  test('a failed attempt reaches every waiting caller, and the next caller tries again', () async {
    int boots = 0;
    FirebaseBoot.debugInitializer = () async {
      boots++;
      if (boots == 1) throw StateError('no Firebase');
      return null;
    };

    await expectLater(FirebaseBoot.ensureInitialized(), throwsStateError);
    await FirebaseBoot.ensureInitialized();
    expect(boots, 2);
  });

  test('a native init that never returns times out instead of hanging its callers', () {
    fakeAsync((FakeAsync async) {
      FirebaseBoot.debugInitializer = () => Completer<Object?>().future;
      Object? error;
      FirebaseBoot.ensureInitialized().catchError((Object e) => error = e);
      async.elapse(FirebaseBoot.timeout - const Duration(milliseconds: 1));
      expect(error, isNull);
      async.elapse(const Duration(milliseconds: 2));
      expect(error, isA<TimeoutException>());
    });
  });

  test('without a test initializer it calls the real plugin, which is absent here and fails', () async {
    await expectLater(FirebaseBoot.ensureInitialized(), throwsA(anything));
  });
}
