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
import 'package:badabhai_worker_app/features/availability_prompt/domain/availability_prompt_gate.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';

class _MockProfileEditRepository extends Mock
    implements ProfileEditRepository {}

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

    test('a row with no status -> due, even with a stored notice', () {
      expect(
        availabilityPromptDue(
          _prefs(availability: const WorkAvailabilityDto(noticeDays: 30)),
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
    late bool enabled;
    late bool signedIn;
    late String? workerId;

    AvailabilityPromptGate gate() => AvailabilityPromptGate(
      repository: repo,
      isSignedIn: () => signedIn,
      workerId: () => workerId,
      isEnabled: () => enabled,
    );

    void stored(WorkPreferencesDto prefs) =>
        when(() => repo.loadWorkPreferences()).thenAnswer((_) async => prefs);

    setUp(() {
      repo = _MockProfileEditRepository();
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
        stored(_prefs(availability: const WorkAvailabilityDto(noticeDays: 30)));

        expect(
          await gate().claim(),
          const AvailabilityPrompt(
            options: _kServed,
            stored: WorkAvailabilityDto(noticeDays: 30),
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

    test('at most once per launch for the same worker — a dismissed prompt '
        'is not asked again this session', () async {
      stored(_prefs());
      final AvailabilityPromptGate g = gate();

      expect(await g.claim(), isNotNull);
      expect(await g.claim(), isNull);
      verify(() => repo.loadWorkPreferences()).called(1);
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
