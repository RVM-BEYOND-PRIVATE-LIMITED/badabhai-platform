import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart' show kConsentVersion;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/consent/data/employer_sharing_prompt_store.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_contact.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_sharing_prompt_gate.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_sharing_prompt_store.dart';

class _MockConsentRepository extends Mock implements ConsentRepository {}

const String _old = '2026-08-28';

const List<String> _basePurposes = <String>[
  'profiling',
  'resume_generation',
  'voice_processing',
];

EmployerContactInfo _row({
  List<String> purposes = _basePurposes,
  String? version = _old,
  String? consentId = 'c1',
  bool revoked = false,
}) =>
    EmployerContactInfo(
      enabled: kEmployerContactPurposes.every(purposes.contains),
      purposes: purposes,
      consentId: consentId,
      consentVersion: version,
      revoked: revoked,
    );

void main() {
  late _MockConsentRepository repo;
  late InMemoryEmployerSharingPromptStore store;
  late bool signedIn;
  late String? workerId;

  EmployerSharingPromptGate gate() => EmployerSharingPromptGate(
        repository: repo,
        store: store,
        isSignedIn: () => signedIn,
        workerId: () => workerId,
      );

  setUp(() {
    repo = _MockConsentRepository();
    store = InMemoryEmployerSharingPromptStore();
    signedIn = true;
    workerId = 'w1';
  });

  void serverSays(EmployerContactInfo info) =>
      when(() => repo.employerContactState()).thenAnswer((_) async => info);

  test('the notice version it compares against is the app consent version', () {
    expect(gate().noticeVersion, kConsentVersion);
    expect(kConsentVersion, '2026-11-04');
  });

  group('show-condition matrix', () {
    test('live row, no employer purposes, OLD version -> show', () async {
      serverSays(_row());
      expect(await gate().claim(), isTrue);
    });

    test('only ONE employer purpose on an old row -> still show', () async {
      serverSays(_row(purposes: <String>[..._basePurposes, 'employer_sharing']));
      expect(await gate().claim(), isTrue);
    });

    test('a row on the CURRENT version -> no (already saw this notice)',
        () async {
      // E.g. granted, then switched off in Settings: purposes lack both, but
      // the row certifies the notice the worker has already read.
      serverSays(_row(version: kConsentVersion));
      expect(await gate().claim(), isFalse);
    });

    test('both employer purposes already present -> no', () async {
      serverSays(_row(purposes: <String>[
        ..._basePurposes,
        ...kEmployerContactPurposes,
      ]));
      expect(await gate().claim(), isFalse);
    });

    test('dismissed on this device for this worker + version -> no', () async {
      serverSays(_row());
      await store.markDismissed(version: kConsentVersion, workerId: 'w1');
      expect(await gate().claim(), isFalse);
    });

    test('GET /consent/me fails -> no, and it does not throw', () async {
      when(() => repo.employerContactState())
          .thenThrow(const NetworkFailure());
      expect(await gate().claim(), isFalse);
    });

    test('revoked row -> no', () async {
      serverSays(_row(revoked: true));
      expect(await gate().claim(), isFalse);
    });

    test('no consent row at all -> no', () async {
      serverSays(_row(consentId: null, version: null, purposes: const <String>[]));
      expect(await gate().claim(), isFalse);
    });

    test('not signed in -> no, and the server is never asked', () async {
      signedIn = false;
      serverSays(_row());
      expect(await gate().claim(), isFalse);
      verifyNever(() => repo.employerContactState());
    });
  });

  test('at most once per launch for the same worker', () async {
    serverSays(_row());
    final EmployerSharingPromptGate g = gate();
    expect(await g.claim(), isTrue);
    expect(await g.claim(), isFalse);
    verify(() => repo.employerContactState()).called(1);
  });

  test('recordDismissal is per worker — the next worker on the phone is asked',
      () async {
    serverSays(_row());
    final EmployerSharingPromptGate g = gate();
    await g.recordDismissal();

    expect(await gate().claim(), isFalse, reason: 'w1 dismissed');
    workerId = 'w2';
    expect(await gate().claim(), isTrue, reason: 'w2 never answered');
  });

  test('a dismissal of an OLDER notice version does not suppress this one',
      () async {
    serverSays(_row());
    await store.markDismissed(version: '2026-01-01', workerId: 'w1');
    expect(await gate().claim(), isTrue);
  });

  test('the dismissal key carries the notice version and the worker', () {
    expect(
      employerSharingDismissKey(version: '2026-11-04', workerId: 'w1'),
      'bb_employer_sharing_dismissed_2026-11-04_w1',
    );
    expect(
      employerSharingDismissKey(version: '2026-11-04', workerId: null),
      'bb_employer_sharing_dismissed_2026-11-04_device',
    );
  });
}
