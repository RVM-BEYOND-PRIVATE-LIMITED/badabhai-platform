import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/extracted_review/domain/extracted_review.dart';
import 'package:badabhai_worker_app/features/extracted_review/domain/extracted_review_repository.dart';
import 'package:badabhai_worker_app/features/extracted_review/presentation/cubit/extracted_review_cubit.dart';

class MockExtractedReviewRepository extends Mock
    implements ExtractedReviewRepository {}

const ExtractedReview _review = ExtractedReview(
  skills: <String>['MIG Welding'],
  machines: <String>['Lathe'],
  experienceYears: 8,
  educations: <EducationEntryDto>[
    EducationEntryDto(credential: 'iti', field: 'Machinist', year: 2018),
  ],
  certificates: <CertificateEntryDto>[
    CertificateEntryDto(name: 'Safety', issuer: 'ITI', year: 2019),
  ],
  profileId: 'profile-1',
  sessionId: 'session-1',
);

const List<CatalogueOptionDto> _skillOptions = <CatalogueOptionDto>[
  CatalogueOptionDto(id: 'skill_gdt_reading', label: 'GD&T / drawing reading'),
  CatalogueOptionDto(id: 'skill_fanuc', label: 'Fanuc control operation'),
  CatalogueOptionDto(id: 'skill_siemens', label: 'Siemens control operation'),
];

const List<CatalogueOptionDto> _machineOptions = <CatalogueOptionDto>[
  CatalogueOptionDto(id: 'mach_cnc_lathe', label: 'CNC Lathe / Turning Center'),
  CatalogueOptionDto(id: 'mach_vmc', label: 'Vertical Machining Center (VMC)'),
];

void _stubLoad(MockExtractedReviewRepository repo,
    [ExtractedReview review = _review]) {
  when(() => repo.load()).thenAnswer((_) async => review);
  when(() => repo.loadQualificationOptions()).thenAnswer(
    (_) async => const QualificationOptionsDto(
      educationCredential: <String, String>{'iti': 'ITI'},
      educationCouncil: <String, String>{'ncvt': 'NCVT'},
    ),
  );
  when(() => repo.loadSkillOptions()).thenAnswer((_) async => _skillOptions);
  when(() => repo.loadMachineOptions())
      .thenAnswer((_) async => _machineOptions);
}

/// A correctable review whose labels partly match the catalogues above.
const ExtractedReview _catalogueReview = ExtractedReview(
  skills: <String>['Fanuc control operation', 'MIG Welding'],
  machines: <String>['Vertical Machining Center (VMC)'],
  profileId: 'profile-1',
  sessionId: 'session-1',
);

void main() {
  late MockExtractedReviewRepository repo;
  setUp(() => repo = MockExtractedReviewRepository());

  group('load', () {
    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'loading then ready, drafts seeded from the server rows',
      build: () {
        _stubLoad(repo);
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) => c.load(),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.status == ExtractedReviewStatus.ready &&
              s.review == _review &&
              s.expYears == 8 &&
              s.eduRows.length == 1 &&
              s.certRows.length == 1 &&
              s.options?.educationCredential['iti'] == 'ITI' &&
              !s.correctionsLocked,
        ),
      ],
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'load failure -> failed with the typed cause',
      build: () {
        when(() => repo.load()).thenThrow(const NetworkFailure());
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) => c.load(),
      expect: () => const <ExtractedReviewState>[
        ExtractedReviewState(status: ExtractedReviewStatus.loading),
        ExtractedReviewState(
          status: ExtractedReviewStatus.failed,
          failure: NetworkFailure(),
        ),
      ],
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'no anchor (form-road) loads fine but locks every correction',
      build: () {
        _stubLoad(repo, const ExtractedReview(
          skills: <String>['MIG Welding'],
          experienceYears: 8,
        ));
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) => c.load(),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.status == ExtractedReviewStatus.ready &&
              s.correctionsLocked &&
              s.review?.canCorrect == false,
        ),
      ],
    );
  });

  group('experience', () {
    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'valid edit POSTs one structured correction, then re-reads',
      build: () {
        _stubLoad(repo);
        when(() => repo.submit(any())).thenAnswer(
          (_) async => (applied: 1, correctionCount: 1),
        );
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.setExperience(9);
        await c.submitExperience();
      },
      verify: (_) {
        final List<ExtractedCorrection> sent =
            verify(() => repo.submit(captureAny())).captured.single
                as List<ExtractedCorrection>;
        expect(sent.single, const ExperienceCorrection(9));
        // Sent + re-read: the corrected value survives only via the GET.
        verify(() => repo.load()).called(2);
      },
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'out-of-range years never POST — honest inline error instead',
      build: () {
        _stubLoad(repo);
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.setExperience(99);
        await c.submitExperience();
      },
      verify: (_) => verifyNever(() => repo.submit(any())),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.status == ExtractedReviewStatus.ready),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.expYears == 99),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.validationError != null),
      ],
    );
  });

  group('education / certificates', () {
    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'edited rows POST the FULL list (replace semantics)',
      build: () {
        _stubLoad(repo);
        when(() => repo.submit(any())).thenAnswer(
          (_) async => (applied: 1, correctionCount: 2),
        );
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.setEducationRows(const <EducationEntryDto>[
          EducationEntryDto(credential: 'iti', field: 'Machinist', year: 2018),
          EducationEntryDto(
              credential: 'diploma',
              field: 'Mechanical',
              year: 2021,
              institute: 'Poly'),
        ]);
        await c.submitEducation();
      },
      verify: (_) {
        final List<ExtractedCorrection> sent =
            verify(() => repo.submit(captureAny())).captured.single
                as List<ExtractedCorrection>;
        final ExtractedCorrection one = sent.single;
        expect(one, isA<EducationCorrection>());
        expect((one as EducationCorrection).educations.length, 2);
      },
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'certificate without an issuer never POSTs (trade-form parity)',
      build: () {
        _stubLoad(repo);
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.setCertificateRows(const <CertificateEntryDto>[
          CertificateEntryDto(name: 'Safety', year: 2019),
        ]);
        await c.submitCertificates();
      },
      verify: (_) => verifyNever(() => repo.submit(any())),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.status == ExtractedReviewStatus.ready),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.certRows.length == 1),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) =>
                (s.validationError ?? '').contains('Kisne diya')),
      ],
    );
  });

  group('409s', () {
    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'unpinned session renders the deferral — surfaced once, never retried',
      build: () {
        _stubLoad(repo);
        when(() => repo.submit(any())).thenThrow(ApiException(
          409,
          'Session has no pack pin',
          body: <String, dynamic>{
            'message': 'deferred — see (unpinned_road_deferred).'
          },
        ));
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.setExperience(9);
        await c.submitExperience();
      },
      verify: (_) => verify(() => repo.submit(any())).called(1),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.status == ExtractedReviewStatus.ready),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.expYears == 9),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.sendingSection != null),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.sendingSection == null &&
              s.rejected == CorrectionRejected.unpinnedRoadDeferred &&
              (s.deferralMessage ?? '').isNotEmpty,
        ),
      ],
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'cap 409 disables every affordance from then on',
      build: () {
        _stubLoad(repo);
        when(() => repo.submit(any())).thenThrow(ApiException(
          409,
          'cap',
          body: <String, dynamic>{
            'message': '(20 lifetime corrections, correction_cap_reached).'
          },
        ));
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.setExperience(9);
        await c.submitExperience();
      },
      verify: (_) => verify(() => repo.submit(any())).called(1),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.status == ExtractedReviewStatus.ready),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.expYears == 9),
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) => s.sendingSection != null),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.rejected == CorrectionRejected.capReached &&
              s.correctionsLocked,
        ),
        // The cap triggers a reload (re-read, like every submit)…
        predicate<ExtractedReviewState>(
            (ExtractedReviewState s) =>
                s.status == ExtractedReviewStatus.loading),
        // …and the known count survives it, so the lock holds.
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.status == ExtractedReviewStatus.ready &&
              s.correctionsLocked &&
              (s.review?.correctionCount ?? 0) >= 20,
        ),
      ],
    );
  });

  group('skills / machines catalogue (#1596)', () {
    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'load pre-ticks exact label matches and lists the rest as unmatched',
      build: () {
        _stubLoad(repo, _catalogueReview);
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) => c.load(),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.status == ExtractedReviewStatus.ready &&
              s.skillPick.status == CatalogueStatus.ready &&
              s.skillPick.options == _skillOptions &&
              s.skillPick.selectedIds.single == 'skill_fanuc' &&
              s.skillPick.unmatchedLabels.single == 'MIG Welding' &&
              s.machinePick.selectedIds.single == 'mach_vmc' &&
              s.machinePick.unmatchedLabels.isEmpty &&
              // Untouched, even with an unmatched label: no save on offer
              // (a no-edit replace would silently drop MIG Welding).
              !s.skillsDirty &&
              // Fully matched and untouched: nothing to save.
              !s.machinesDirty,
        ),
      ],
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'only a worker tick makes the section dirty; ticking back clears it',
      build: () {
        _stubLoad(repo, _catalogueReview);
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.toggleSkill('skill_siemens');
        c.toggleSkill('skill_siemens');
      },
      skip: 2,
      expect: () => <Object?>[
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.skillPick.isSelected('skill_siemens') &&
              s.skillPick.unmatchedLabels.single == 'MIG Welding' &&
              s.skillsDirty,
        ),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              !s.skillPick.isSelected('skill_siemens') &&
              s.skillPick.unmatchedLabels.single == 'MIG Welding' &&
              !s.skillsDirty,
        ),
      ],
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'a catalogue miss fails ITS card with the typed cause — never the review',
      build: () {
        _stubLoad(repo, _catalogueReview);
        when(() => repo.loadSkillOptions())
            .thenThrow(const ConsentRequiredFailure());
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) => c.load(),
      expect: () => <Object?>[
        const ExtractedReviewState(status: ExtractedReviewStatus.loading),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.status == ExtractedReviewStatus.ready &&
              s.skillPick.status == CatalogueStatus.failed &&
              s.skillPick.failure == const ConsentRequiredFailure() &&
              !s.skillsDirty &&
              s.machinePick.status == CatalogueStatus.ready,
        ),
      ],
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'retry re-fetches only the failed catalogue, with its own loader',
      build: () {
        _stubLoad(repo, _catalogueReview);
        int calls = 0;
        when(() => repo.loadSkillOptions()).thenAnswer((_) async {
          calls++;
          if (calls == 1) throw const NetworkFailure();
          return _skillOptions;
        });
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        await c.retryCatalogues();
      },
      skip: 2,
      expect: () => <Object?>[
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.skillPick.status == CatalogueStatus.loading &&
              s.machinePick.status == CatalogueStatus.ready,
        ),
        predicate<ExtractedReviewState>(
          (ExtractedReviewState s) =>
              s.skillPick.status == CatalogueStatus.ready &&
              s.skillPick.selectedIds.single == 'skill_fanuc',
        ),
      ],
      verify: (_) {
        verify(() => repo.loadSkillOptions()).called(2);
        verify(() => repo.loadMachineOptions()).called(1);
      },
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'ticks POST catalogue ids only (catalogue order), then re-read without '
      're-fetching the static catalogue',
      build: () {
        _stubLoad(repo, _catalogueReview);
        when(() => repo.submit(any())).thenAnswer(
          (_) async => (applied: 1, correctionCount: 1),
        );
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.toggleSkill('skill_siemens');
        c.toggleSkill('skill_gdt_reading');
        c.toggleSkill('not_in_catalogue');
        await c.submitSkills();
      },
      verify: (ExtractedReviewCubit c) {
        final List<ExtractedCorrection> sent =
            verify(() => repo.submit(captureAny())).captured.single
                as List<ExtractedCorrection>;
        expect(
          sent.single,
          const SkillsCorrection(
              <String>['skill_gdt_reading', 'skill_fanuc', 'skill_siemens']),
        );
        verify(() => repo.load()).called(2);
        verify(() => repo.loadSkillOptions()).called(1);
        expect(c.state.lastSent, (field: 'skills', applied: 1));
      },
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'machines POST a MachinesCorrection',
      build: () {
        _stubLoad(repo, _catalogueReview);
        when(() => repo.submit(any())).thenAnswer(
          (_) async => (applied: 1, correctionCount: 1),
        );
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.toggleMachine('mach_cnc_lathe');
        await c.submitMachines();
      },
      verify: (_) {
        final List<ExtractedCorrection> sent =
            verify(() => repo.submit(captureAny())).captured.single
                as List<ExtractedCorrection>;
        expect(sent.single,
            const MachinesCorrection(<String>['mach_cnc_lathe', 'mach_vmc']));
      },
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'an empty list never POSTs (the DTO needs one id) — honest inline error',
      build: () {
        _stubLoad(repo, _catalogueReview);
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.toggleMachine('mach_vmc');
        await c.submitMachines();
      },
      verify: (ExtractedReviewCubit c) {
        verifyNever(() => repo.submit(any()));
        expect(c.state.machinePick.selectedIds, isEmpty);
        expect(c.state.machinesDirty, isTrue);
        expect(c.state.validationError, contains('Kam se kam ek machine'));
      },
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'a tick past the server cap is refused with the cap in the message',
      build: () {
        final List<CatalogueOptionDto> big = <CatalogueOptionDto>[
          for (int i = 0; i <= kMaxCorrectionSkills; i++)
            CatalogueOptionDto(id: 'skill_$i', label: 'Skill $i'),
        ];
        _stubLoad(
          repo,
          ExtractedReview(
            skills: <String>[
              for (int i = 0; i < kMaxCorrectionSkills; i++) 'Skill $i',
            ],
            profileId: 'profile-1',
            sessionId: 'session-1',
          ),
        );
        when(() => repo.loadSkillOptions()).thenAnswer((_) async => big);
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        c.toggleSkill('skill_$kMaxCorrectionSkills');
      },
      verify: (ExtractedReviewCubit c) {
        expect(c.state.skillPick.selectedIds, hasLength(kMaxCorrectionSkills));
        expect(c.state.skillPick.isSelected('skill_$kMaxCorrectionSkills'),
            isFalse);
        expect(c.state.validationError, contains('$kMaxCorrectionSkills'));
      },
    );

    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'no anchor: the catalogues are never fetched (nothing to pick into)',
      build: () {
        _stubLoad(repo, const ExtractedReview(skills: <String>['X']));
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) => c.load(),
      verify: (ExtractedReviewCubit c) {
        verifyNever(() => repo.loadSkillOptions());
        verifyNever(() => repo.loadMachineOptions());
        expect(c.state.skillPick.status, CatalogueStatus.idle);
        expect(c.state.correctionsLocked, isTrue);
      },
    );
  });

  group('matchCatalogueLabels', () {
    test('exact label only; ambiguous or unknown labels are never guessed',
        () {
      const List<CatalogueOptionDto> options = <CatalogueOptionDto>[
        CatalogueOptionDto(id: 'skill_b', label: 'B'),
        CatalogueOptionDto(id: 'skill_a', label: 'A'),
        CatalogueOptionDto(id: 'skill_d1', label: 'Dup'),
        CatalogueOptionDto(id: 'skill_d2', label: 'Dup'),
      ];
      final ({List<String> ids, List<String> unmatched}) m =
          matchCatalogueLabels(
        <String>['A', 'b', 'Dup', 'B', 'A', 'Other'],
        options,
      );
      // Catalogue order, deduped.
      expect(m.ids, <String>['skill_b', 'skill_a']);
      // Case differs, shared by two options, or not in the catalogue.
      expect(m.unmatched, <String>['b', 'Dup', 'Other']);
    });
  });

  group('confirm', () {
    blocTest<ExtractedReviewCubit, ExtractedReviewState>(
      'confirm renders the confirmed state with the server next-step',
      build: () {
        _stubLoad(repo);
        when(() => repo.confirm()).thenAnswer((_) async => 'chat_complete');
        return ExtractedReviewCubit(repo);
      },
      act: (ExtractedReviewCubit c) async {
        await c.load();
        await c.confirm();
      },
      verify: (_) => verify(() => repo.confirm()).called(1),
    );
  });
}
