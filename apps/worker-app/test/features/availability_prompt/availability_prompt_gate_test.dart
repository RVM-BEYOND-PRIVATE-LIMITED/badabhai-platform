import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show
        WorkAvailabilityDto,
        WorkPrefOptionsDto,
        WorkPreferencesDto,
        kAvailabilityStatusLabels;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/availability_prompt/data/availability_prompt_store.dart';
import 'package:badabhai_worker_app/features/availability_prompt/domain/availability_prompt_gate.dart';
import 'package:badabhai_worker_app/features/availability_prompt/domain/availability_prompt_store.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';

class _MockProfileEditRepository extends Mock
    implements ProfileEditRepository {}

/// A store whose platform channel is gone: every call throws.
class _BrokenStore implements AvailabilityPromptStore {
  @override
  Future<bool> isDismissed({String? workerId}) =>
      Future<bool>.error(StateError('no plugin'));

  @override
  Future<void> markDismissed({String? workerId}) =>
      Future<void>.error(StateError('no plugin'));
}

/// `availability.status`'s closed set ON THE SERVER TODAY
/// (`AVAILABILITY_STATUSES` in apps/api/src/profiles/worker-preferences.vocabulary.ts,
/// validated by the PUT's strict `z.enum`). Pinned here as literals: the
/// prompt may only ever send these — never the values #2753 plans.
const List<String> _kServerAvailabilityStatuses = <String>[
  'immediate',
  'within_week',
  'within_month',
  'serving_notice',
];

const Map<String, String> _kServed = <String, String>{
  'immediate': 'Immediately',
  'within_week': 'Within a week',
  'within_month': 'Within a month',
  'serving_notice': 'Serving notice',
};

WorkPreferencesDto _prefs({
  WorkAvailabilityDto? availability,
  List<String> partial = const <String>[],
}) => WorkPreferencesDto(availability: availability, partial: partial);

WorkPrefOptionsDto _options({
  Map<String, String> availabilityStatus = _kServed,
}) => WorkPrefOptionsDto(
  languages: const <String, String>{},
  documentsReady: const <String, String>{},
  jobType: const <String, String>{},
  shift: const <String, String>{},
  availabilityStatus: availabilityStatus,
);

void main() {
  group('availabilityPromptDue — only an EMPTY availability is asked', () {
    test('no stored row -> due', () {
      expect(availabilityPromptDue(_prefs()), isTrue);
    });

    test('a row with every part blank -> due', () {
      expect(
        availabilityPromptDue(
          _prefs(availability: const WorkAvailabilityDto()),
        ),
        isTrue,
      );
      expect(
        availabilityPromptDue(
          _prefs(
            availability: const WorkAvailabilityDto(
              status: '  ',
              availableFrom: ' ',
            ),
          ),
        ),
        isTrue,
      );
    });

    test('a blank status -> due', () {
      expect(
        availabilityPromptDue(
          _prefs(availability: const WorkAvailabilityDto(status: '  ')),
        ),
        isTrue,
      );
    });

    // The Profile tab prints each part on its own ("Kab se: …", "Notice: …
    // din"), so a worker with any of them stored is never told it is empty.
    test('a stored date without a status -> not due', () {
      expect(
        availabilityPromptDue(
          _prefs(
            availability: const WorkAvailabilityDto(
              availableFrom: '2026-12-01',
            ),
          ),
        ),
        isFalse,
      );
    });

    test('a stored notice without a status -> not due', () {
      expect(
        availabilityPromptDue(
          _prefs(availability: const WorkAvailabilityDto(noticeDays: 30)),
        ),
        isFalse,
      );
    });

    test('a notice of 0 days is stored, not empty -> not due', () {
      expect(
        availabilityPromptDue(
          _prefs(availability: const WorkAvailabilityDto(noticeDays: 0)),
        ),
        isFalse,
      );
    });

    test('a stored status -> not due', () {
      expect(
        availabilityPromptDue(
          _prefs(availability: const WorkAvailabilityDto(status: 'immediate')),
        ),
        isFalse,
      );
    });

    test('a WITHHELD value is stored, not empty -> not due', () {
      // The read withheld it (`partial`), and the PUT replaces the whole
      // object: asking would overwrite an answer the worker already gave.
      expect(
        availabilityPromptDue(_prefs(partial: const <String>['availability'])),
        isFalse,
      );
    });
  });

  group('availabilityPromptOptions — only the server\'s current values', () {
    test('the served dictionary wins, in the server\'s order', () {
      expect(
        availabilityPromptOptions(_options()).keys.toList(),
        _kServerAvailabilityStatuses,
      );
      expect(availabilityPromptOptions(_options()), _kServed);
    });

    test('a server that predates the key gets the static copy', () {
      expect(
        availabilityPromptOptions(
          _options(availabilityStatus: const <String, String>{}),
        ),
        kAvailabilityStatusLabels,
      );
    });

    test('the static copy carries exactly today\'s server slugs', () {
      // A slug the strict enum does not know fails the WHOLE save with a 400.
      expect(
        kAvailabilityStatusLabels.keys.toList(),
        _kServerAvailabilityStatuses,
      );
    });
  });

  group('availabilityPromptBody — the availability key and nothing else', () {
    test('a worker with no stored row sends the status alone', () {
      expect(availabilityPromptBody('within_week'), <String, dynamic>{
        'touched_only': true,
        'availability': <String, dynamic>{
          'status': 'within_week',
          'available_from': null,
          'notice_period_days': null,
        },
      });
    });

    test(
      'the stored date and notice ride along — the PUT replaces the object',
      () {
        expect(
          availabilityPromptBody(
            'serving_notice',
            stored: const WorkAvailabilityDto(
              availableFrom: '2026-12-01',
              noticeDays: 30,
            ),
          ),
          <String, dynamic>{
            'touched_only': true,
            'availability': <String, dynamic>{
              'status': 'serving_notice',
              'available_from': '2026-12-01',
              'notice_period_days': 30,
            },
          },
        );
      },
    );
  });

  group('AvailabilityPromptGate.claim', () {
    late _MockProfileEditRepository repo;
    late InMemoryAvailabilityPromptStore store;
    late bool enabled;
    late bool signedIn;
    late String? workerId;

    /// A gate is one app launch: a fresh one has a fresh launch memory, over
    /// the same device [store].
    AvailabilityPromptGate gate() => AvailabilityPromptGate(
      repository: repo,
      store: store,
      isSignedIn: () => signedIn,
      workerId: () => workerId,
      isEnabled: () => enabled,
    );

    void stored(WorkPreferencesDto prefs) =>
        when(() => repo.loadWorkPreferences()).thenAnswer((_) async => prefs);

    setUp(() {
      repo = _MockProfileEditRepository();
      store = InMemoryAvailabilityPromptStore();
      enabled = true;
      signedIn = true;
      workerId = 'w1';
      when(
        () => repo.loadWorkPreferenceOptions(),
      ).thenAnswer((_) async => _options());
    });

    test(
      'an empty availability -> the prompt, with the served choices',
      () async {
        stored(_prefs(availability: const WorkAvailabilityDto()));

        expect(
          await gate().claim(),
          const AvailabilityPrompt(
            options: _kServed,
            stored: WorkAvailabilityDto(),
          ),
        );
      },
    );

    test(
      'a stored status -> no prompt, and the options are never read',
      () async {
        stored(
          _prefs(
            availability: const WorkAvailabilityDto(status: 'within_month'),
          ),
        );

        expect(await gate().claim(), isNull);
        verifyNever(() => repo.loadWorkPreferenceOptions());
      },
    );

    test(
      'a stored date or notice without a status -> no prompt, and the options '
      'are never read',
      () async {
        stored(
          _prefs(
            availability: const WorkAvailabilityDto(
              availableFrom: '2026-12-01',
              noticeDays: 30,
            ),
          ),
        );

        expect(await gate().claim(), isNull);
        verifyNever(() => repo.loadWorkPreferenceOptions());
      },
    );

    test('the switch is OFF -> no prompt, and nothing is read', () async {
      enabled = false;
      stored(_prefs());

      expect(await gate().claim(), isNull);
      verifyNever(() => repo.loadWorkPreferences());
      verifyNever(() => repo.loadWorkPreferenceOptions());
    });

    test('the Remote Config switch ships OFF', () async {
      BbRemoteConfig.instance.debugReset();
      addTearDown(BbRemoteConfig.instance.debugReset);
      stored(_prefs());

      final AvailabilityPromptGate defaultGate = AvailabilityPromptGate(
        repository: repo,
        store: store,
        isSignedIn: () => true,
        workerId: () => 'w1',
      );
      expect(await defaultGate.claim(), isNull);
      verifyNever(() => repo.loadWorkPreferences());

      BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyAvailabilityPromptEnabled: true,
      });
      expect(await defaultGate.claim(), isNotNull);
    });

    test('not signed in -> no prompt, and nothing is read', () async {
      signedIn = false;
      stored(_prefs());

      expect(await gate().claim(), isNull);
      verifyNever(() => repo.loadWorkPreferences());
    });

    test('a failed read -> no prompt, and no throw', () async {
      when(() => repo.loadWorkPreferences()).thenThrow(const NetworkFailure());

      expect(await gate().claim(), isNull);
    });

    test('a failed options read -> no prompt, and no throw', () async {
      stored(_prefs());
      when(
        () => repo.loadWorkPreferenceOptions(),
      ).thenThrow(const NetworkFailure());

      expect(await gate().claim(), isNull);
    });

    test('at most once per launch for the same worker', () async {
      stored(_prefs());
      final AvailabilityPromptGate g = gate();

      expect(await g.claim(), isNotNull);
      expect(await g.claim(), isNull);
      verify(() => repo.loadWorkPreferences()).called(1);
    });

    test('a "not now" is remembered: the next launch asks nothing and reads '
        'nothing', () async {
      stored(_prefs());
      final AvailabilityPromptGate firstLaunch = gate();
      expect(await firstLaunch.claim(), isNotNull);
      await firstLaunch.recordDismissal();

      expect(await store.isDismissed(workerId: 'w1'), isTrue);
      expect(await gate().claim(), isNull, reason: 'the next launch');
      verify(() => repo.loadWorkPreferences()).called(1);
      verify(() => repo.loadWorkPreferenceOptions()).called(1);
    });

    test('a launch with no "not now" on record still asks — only a dismissal '
        'is remembered', () async {
      stored(_prefs());
      expect(await gate().claim(), isNotNull);
      expect(await gate().claim(), isNotNull, reason: 'the next launch');
    });

    test(
      'the "not now" is per worker: the next worker on the phone is asked',
      () async {
        stored(_prefs());
        final AvailabilityPromptGate g = gate();
        expect(await g.claim(), isNotNull);
        await g.recordDismissal();

        workerId = 'w2';
        expect(await gate().claim(), isNotNull, reason: 'w2 never answered');
        workerId = 'w1';
        expect(await gate().claim(), isNull, reason: 'w1 said not now');
      },
    );

    test('a store that cannot be read or written fails quiet', () async {
      stored(_prefs());
      final AvailabilityPromptGate g = AvailabilityPromptGate(
        repository: repo,
        store: _BrokenStore(),
        isSignedIn: () => true,
        workerId: () => 'w1',
        isEnabled: () => true,
      );

      expect(await g.claim(), isNull, reason: 'any failure means no prompt');
      await g.recordDismissal();
    });

    test('the dismissal key carries the worker, or one device slot', () {
      expect(
        availabilityPromptDismissKey(workerId: 'w1'),
        'bb_availability_prompt_dismissed_w1',
      );
      expect(
        availabilityPromptDismissKey(workerId: null),
        'bb_availability_prompt_dismissed_device',
      );
      expect(
        availabilityPromptDismissKey(workerId: ''),
        'bb_availability_prompt_dismissed_device',
      );
    });

    test('the next worker on the same phone gets their own check', () async {
      stored(_prefs());
      final AvailabilityPromptGate g = gate();

      expect(await g.claim(), isNotNull);
      workerId = 'w2';
      expect(await g.claim(), isNotNull);
    });

    test('a check made while the switch was off is not used up', () async {
      stored(_prefs());
      final AvailabilityPromptGate g = gate();

      enabled = false;
      expect(await g.claim(), isNull);
      enabled = true;
      expect(
        await g.claim(),
        isNotNull,
        reason:
            'a switch that activates after the first frame still gets '
            'its one check',
      );
    });
  });
}
