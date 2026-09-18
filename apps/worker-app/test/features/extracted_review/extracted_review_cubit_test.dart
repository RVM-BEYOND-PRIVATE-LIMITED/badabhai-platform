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

void _stubLoad(MockExtractedReviewRepository repo,
    [ExtractedReview review = _review]) {
  when(() => repo.load()).thenAnswer((_) async => review);
  when(() => repo.loadQualificationOptions()).thenAnswer(
    (_) async => const QualificationOptionsDto(
      educationCredential: <String, String>{'iti': 'ITI'},
      educationCouncil: <String, String>{'ncvt': 'NCVT'},
    ),
  );
}

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
