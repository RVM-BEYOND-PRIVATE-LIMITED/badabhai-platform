import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/session/session_repository.dart';

void main() {
  test('setWorker stores worker + token; later mutators update their fields', () {
    final SessionRepository s = SessionRepository();
    expect(s.sessionToken, isNull);
    expect(s.workerId, isNull);

    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 't1');
    expect(s.phoneE164, '+910000000000');
    expect(s.workerId, 'w1');
    expect(s.sessionToken, 't1');

    s.setSessionToken('t2');
    expect(s.sessionToken, 't2');
    // unrelated fields are preserved across mutations
    expect(s.workerId, 'w1');

    s.setSession('sess1');
    s.setProfile('p1');
    s.setResume('r1');
    expect(s.sessionId, 'sess1');
    expect(s.profileId, 'p1');
    expect(s.resumeId, 'r1');
    expect(s.workerId, 'w1');
    expect(s.sessionToken, 't2');
  });

  test('clear() nulls every session field (logout wipe)', () {
    final SessionRepository s = SessionRepository();
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 't1');
    s.setSession('sess1');
    s.setProfile('p1');
    s.setResume('r1');
    s.setDeletionScheduledFor(DateTime.utc(2026, 7, 21));
    // Sanity: state is populated before the wipe.
    expect(s.workerId, 'w1');
    expect(s.sessionToken, 't1');
    expect(s.deletionScheduledFor, isNotNull);

    s.clear();

    expect(s.phoneE164, isNull);
    expect(s.workerId, isNull);
    expect(s.sessionToken, isNull);
    expect(s.sessionId, isNull);
    expect(s.profileId, isNull);
    expect(s.resumeId, isNull);
    expect(s.deletionScheduledFor, isNull);
  });

  test(
      'setDeletionScheduledFor sets AND clears (null) the pending flag '
      'without touching the rest of the session', () {
    final SessionRepository s = SessionRepository();
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 't1');
    final DateTime due = DateTime.utc(2026, 7, 21, 12);

    s.setDeletionScheduledFor(due);
    expect(s.deletionScheduledFor, due);
    // Unrelated fields survive.
    expect(s.workerId, 'w1');
    expect(s.sessionToken, 't1');

    // null CLEARS the flag (a copyWith `??` would swallow it) — the cancel path.
    s.setDeletionScheduledFor(null);
    expect(s.deletionScheduledFor, isNull);
    expect(s.workerId, 'w1');
    expect(s.sessionToken, 't1');
  });
}
