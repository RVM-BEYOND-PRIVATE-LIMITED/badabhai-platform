import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

/// #1710 — the marker pages must LOAD what is saved before they save.
///
/// Each of the three pages is a WHOLE-RECORD PUT, and until this issue none of
/// them read the stored record first. The failure it produced is not subtle: a
/// worker with three stored jobs who was re-served the employment page by an
/// Easy→Medium upgrade, added one job and saved, lost the other three.
///
/// These tests are written against the issue's own acceptance list.
class _MockRepo extends Mock implements TradeFormRepository {}

TradeFormEmploymentEntry _job(String employer, {String? work}) =>
    TradeFormEmploymentEntry(
      employerName: employer,
      roleLabel: 'Fitter',
      startYm: '2019-01',
      endYm: '2020-01',
      stillWorking: false,
      workDone: work ?? '$employer ka kaam',
    );

/// A form whose every question is answered, so the walk opens on the markers.
TradeForm _form({
  TradeFormTierScope prefs = TradeFormTierScope.unscoped,
  TradeFormTierScope employment = TradeFormTierScope.unscoped,
  TradeFormTierScope quals = TradeFormTierScope.unscoped,
}) =>
    TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 'finish',
          title: 'Finish',
          screens: <TradeFormStep>[
            TradeFormPreferencesStep(tierScope: prefs),
            TradeFormEmploymentStep(tierScope: employment),
            TradeFormQualificationsStep(tierScope: quals),
          ],
        ),
      ],
    );

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const TradeFormPreferences());
    registerFallbackValue(<TradeFormEmploymentEntry>[]);
    registerFallbackValue(const TradeFormQualifications());
  });

  setUp(() {
    repo = _MockRepo();
    when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
    when(() => repo.loadSavedEmployment())
        .thenAnswer((_) async => const TradeFormStoredEmployment());
    when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveQualifications(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any(),
        expectedExistingCount: any(named: 'expectedExistingCount'))).thenAnswer((_) async {});
  });

  group('the stored record reaches the page (#1710 part 1)', () {
    test('every marker page opens on what the worker actually saved', () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form());
      when(() => repo.loadSavedPreferences()).thenAnswer((_) async =>
          const TradeFormPreferences(languages: <String>{'hindi'}));
      when(() => repo.loadSavedEmployment()).thenAnswer((_) async =>
          TradeFormStoredEmployment(
            entries: <TradeFormEmploymentEntry>[_job('Acme')],
            expectedExistingCount: 1,
          ));
      when(() => repo.loadSavedQualifications()).thenAnswer((_) async =>
          const TradeFormQualifications(
            certificates: <TradeFormCertificateEntry>[
              TradeFormCertificateEntry(name: 'ITI'),
            ],
          ));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();

      expect(cubit.state.savedPreferences?.languages, <String>{'hindi'});
      expect(cubit.state.savedEmployment?.single.employerName, 'Acme');
      expect(cubit.state.savedQualifications?.certificates.single.name, 'ITI');
    });

    test('a read that fails FAILS THE LOAD — it never opens a blank page',
        () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form());
      when(() => repo.loadSavedEmployment())
          .thenThrow(const ServerFailure(500));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();

      // A blank employment page is the state in which a save DELETES the
      // history, so the honest answer is the form's ordinary retry.
      expect(cubit.state.status, TradeFormStatus.loadError);
      expect(cubit.state.savedEmployment, isNull);
    });

    test('only the markers the form carries are read', () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => TradeForm(
                kind: 'k',
                packId: 'p',
                packVersion: 1,
                sections: const <TradeFormSection>[
                  TradeFormSection(
                    id: 's',
                    title: 'S',
                    screens: <TradeFormStep>[TradeFormEmploymentStep()],
                  ),
                ],
              ));

      await TradeFormCubit(repo).load();

      verify(() => repo.loadSavedEmployment()).called(1);
      verifyNever(() => repo.loadSavedPreferences());
      verifyNever(() => repo.loadSavedQualifications());
    });
  });

  group('the whole-history replace is guarded (#1710 acceptance)', () {
    test('3 stored jobs with descriptions survive editing one and saving',
        () async {
      final List<TradeFormEmploymentEntry> stored = <TradeFormEmploymentEntry>[
        _job('Acme'),
        _job('Bharat Forge'),
        _job('Crompton'),
      ];
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form());
      when(() => repo.loadSavedEmployment()).thenAnswer((_) async =>
          TradeFormStoredEmployment(
              entries: stored, expectedExistingCount: 3));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();
      await cubit.savePreferencesAndAdvance(const TradeFormPreferences());

      // The worker edits ONE field on the first card and saves the page.
      final List<TradeFormEmploymentEntry> edited =
          List<TradeFormEmploymentEntry>.of(cubit.state.savedEmployment!)
            ..[0] = stored.first.copyWith(roleLabel: 'Senior Fitter');
      await cubit.saveEmploymentAndAdvance(edited);

      final List<TradeFormEmploymentEntry> sent = verify(() =>
                  repo.saveEmployment(captureAny(),
                      expectedExistingCount:
                          any(named: 'expectedExistingCount')))
              .captured
              .single as List<TradeFormEmploymentEntry>;

      expect(sent.length, 3, reason: 'all three jobs must survive');
      expect(sent.map((TradeFormEmploymentEntry e) => e.employerName),
          <String>['Acme', 'Bharat Forge', 'Crompton']);
      expect(
        sent.every((TradeFormEmploymentEntry e) =>
            (e.workDone ?? '').trim().isNotEmpty),
        isTrue,
        reason: 'all three descriptions must survive',
      );
      expect(sent.first.roleLabel, 'Senior Fitter');
    });

    test('the save echoes the count the page prefilled from', () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form());
      when(() => repo.loadSavedEmployment()).thenAnswer((_) async =>
          TradeFormStoredEmployment(
            entries: <TradeFormEmploymentEntry>[_job('Acme')],
            // One row was withheld as undecryptable — it is NOT in `entries`
            // and it still counts, or the save would 409 forever.
            expectedExistingCount: 2,
          ));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();
      await cubit.savePreferencesAndAdvance(const TradeFormPreferences());
      await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[
        _job('Acme'),
      ]);

      verify(() => repo.saveEmployment(any(), expectedExistingCount: 2))
          .called(1);
    });

    test('a 409 RELOADS and retries against the fresh count, never resends '
        'the stale one', () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form());
      int reads = 0;
      when(() => repo.loadSavedEmployment()).thenAnswer((_) async {
        reads += 1;
        return TradeFormStoredEmployment(
          entries: <TradeFormEmploymentEntry>[_job('Acme')],
          // The history grew under this walk between the two reads.
          expectedExistingCount: reads == 1 ? 1 : 2,
        );
      });
      final List<int?> counts = <int?>[];
      when(() => repo.saveEmployment(any(),
          expectedExistingCount:
              any(named: 'expectedExistingCount'))).thenAnswer((Invocation i) async {
        final int? c = i.namedArguments[#expectedExistingCount] as int?;
        counts.add(c);
        if (c == 1) throw const ServerFailure(409);
      });

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();
      await cubit.savePreferencesAndAdvance(const TradeFormPreferences());
      await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[
        _job('Acme'),
      ]);

      expect(counts, <int?>[1, 2], reason: 'retried with the RE-READ count');
      expect(reads, 2, reason: 'the 409 forced a re-read');
      expect(cubit.state.submitError, isNull);
    });

    test('a second 409 stops, with an honest message rather than a loop',
        () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form());
      when(() => repo.loadSavedEmployment()).thenAnswer((_) async =>
          TradeFormStoredEmployment(
              entries: <TradeFormEmploymentEntry>[_job('Acme')],
              expectedExistingCount: 1));
      when(() => repo.saveEmployment(any(),
              expectedExistingCount: any(named: 'expectedExistingCount')))
          .thenThrow(const ServerFailure(409));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();
      await cubit.savePreferencesAndAdvance(const TradeFormPreferences());
      await cubit.saveEmploymentAndAdvance(<TradeFormEmploymentEntry>[
        _job('Acme'),
      ]);

      expect(cubit.state.submitError, kTradeFormEmploymentChangedMessage);
      expect(cubit.state.status, TradeFormStatus.ready);
    });
  });

  group('a multi-stint employer is not flattened away (#1710)', () {
    test('every stint goes back, with the card edit on the one it showed', () {
      final TradeFormEmploymentEntry e = TradeFormEmploymentEntry(
        employerName: 'Acme',
        roleLabel: 'Senior Fitter',
        startYm: '2018-01',
        endYm: '2022-01',
        stillWorking: false,
        workDone: 'naya kaam',
        storedRoles: const <Map<String, dynamic>>[
          <String, dynamic>{
            'role_label': 'Fitter',
            'start_ym': '2018-01',
            'end_ym': '2020-01',
            'work_done': 'purana kaam',
            'work_done_voice_note_id': null,
          },
          <String, dynamic>{
            'role_label': 'Supervisor',
            'start_ym': '2020-02',
            'end_ym': '2022-01',
            'work_done': 'supervision',
            'work_done_voice_note_id': null,
          },
        ],
      );

      final Map<String, dynamic> body = e.toJson();
      final List<dynamic> roles = body['roles'] as List<dynamic>;

      expect(body.containsKey('role_label'), isFalse,
          reason: 'the entry schema forbids mixing the shorthand with roles[]');
      expect(roles.length, 2, reason: 'the second stint must survive');
      expect((roles[0] as Map<String, dynamic>)['role_label'], 'Senior Fitter');
      expect((roles[0] as Map<String, dynamic>)['work_done'], 'naya kaam');
      expect((roles[1] as Map<String, dynamic>)['role_label'], 'Supervisor');
      expect((roles[1] as Map<String, dynamic>)['work_done'], 'supervision');
    });

    test('a single-stint employer still sends the flat shorthand', () {
      expect(_job('Acme').toJson()['role_label'], 'Fitter');
      expect(_job('Acme').toJson().containsKey('roles'), isFalse);
    });
  });

  group('tier_scope is ask-only (#1698 part 2, via #1710)', () {
    test('an upgrade page whose revealed fields are all answered is skipped',
        () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form(
                // The upgrade adds `documents_ready` to preferences, and the
                // worker already answered it.
                prefs: const TradeFormTierScope(
                    revealFields: <String>{kTierFieldDocumentsReady}),
                // `certificates` is likewise already answered.
                quals: const TradeFormTierScope(
                    revealFields: <String>{kTierFieldCertificates}),
              ));
      when(() => repo.loadSavedPreferences()).thenAnswer((_) async =>
          const TradeFormPreferences(documentsReady: <String>{'aadhaar'}));
      when(() => repo.loadSavedQualifications()).thenAnswer((_) async =>
          const TradeFormQualifications(
            certificates: <TradeFormCertificateEntry>[
              TradeFormCertificateEntry(name: 'ITI'),
            ],
          ));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load(upgradeView: true);

      final List<TradeFormStep> steps = cubit.state.flatSteps
          .map((TradeFormFlatStep f) => f.step)
          .toList();
      expect(steps.whereType<TradeFormPreferencesStep>(), isEmpty);
      expect(steps.whereType<TradeFormQualificationsStep>(), isEmpty);
      expect(steps.whereType<TradeFormEmploymentStep>(), hasLength(1));
    });

    test('a revealed field with NO saved value keeps its page', () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form(
                prefs: const TradeFormTierScope(
                    revealFields: <String>{kTierFieldDocumentsReady}),
              ));
      when(() => repo.loadSavedPreferences())
          .thenAnswer((_) async => const TradeFormPreferences());

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load(upgradeView: true);

      expect(
        cubit.state.flatSteps
            .map((TradeFormFlatStep f) => f.step)
            .whereType<TradeFormPreferencesStep>(),
        hasLength(1),
      );
    });

    test('"add more jobs" is an invitation, never an answered fact', () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form(
                employment: const TradeFormTierScope(revealFields: <String>{
                  kTierFieldWorkDone,
                  kTierFieldAdditionalEntries,
                }),
              ));
      // Every stored job already HAS a description, so `work_done` alone would
      // not earn the page — `additional_entries` still does.
      when(() => repo.loadSavedEmployment()).thenAnswer((_) async =>
          TradeFormStoredEmployment(
              entries: <TradeFormEmploymentEntry>[_job('Acme')],
              expectedExistingCount: 1));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load(upgradeView: true);

      expect(
        cubit.state.flatSteps
            .map((TradeFormFlatStep f) => f.step)
            .whereType<TradeFormEmploymentStep>(),
        hasLength(1),
      );
    });

    test('an ordinary load never skips a page — reveal_fields is absent', () async {
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => _form(
                prefs: const TradeFormTierScope(
                    hiddenFields: <String>{kTierFieldDocumentsReady}),
              ));

      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();

      expect(cubit.state.flatSteps, hasLength(3));
    });
  });

  group('TradeFormTierScope parsing', () {
    test('hidden and revealed fields are read; a missing scope asks everything',
        () {
      final TradeFormTierScope? s = TradeFormTierScope.fromJson(
        <String, dynamic>{
          'hidden_fields': <String>['work_done'],
          'reveal_fields': <String>['additional_entries'],
        },
      );
      expect(s!.hides(kTierFieldWorkDone), isTrue);
      expect(s.revealFields, <String>{kTierFieldAdditionalEntries});

      expect(TradeFormTierScope.fromJson(null), isNull);
      expect(TradeFormTierScope.unscoped.hides(kTierFieldWorkDone), isFalse);
      expect(TradeFormTierScope.unscoped.revealFields, isNull,
          reason: 'null (ask normally) is NOT empty (nothing left to ask)');
    });
  });
}
