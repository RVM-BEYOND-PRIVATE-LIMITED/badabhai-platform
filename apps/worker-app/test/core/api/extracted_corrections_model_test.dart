import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

/// #1595 — the corrections wire shapes: structured-only bodies and the
/// stable 409 codes. A wrong key here is a 400/422 the worker waits on, so
/// the shapes are pinned.
void main() {
  group('correction bodies carry the discriminator + structured fields', () {
    test('experience', () {
      expect(
        const ExperienceCorrection(9).toJson(),
        <String, dynamic>{'field': 'experience', 'total_years': 9},
      );
    });

    test('education full list replaces, with the PUT keys', () {
      expect(
        const EducationCorrection(<EducationEntryDto>[
          EducationEntryDto(
              credential: 'iti', field: 'Machinist', year: 2018),
        ]).toJson(),
        <String, dynamic>{
          'field': 'education',
          'educations': <dynamic>[
            <String, dynamic>{
              'credential': 'iti',
              'field': 'Machinist',
              'council': null,
              'year': 2018,
              'institute': null,
            },
          ],
        },
      );
    });

    test('certificates preserve licence fields (read-modify-write safe)', () {
      expect(
        const CertificatesCorrection(<CertificateEntryDto>[
          CertificateEntryDto(
              name: 'Driving', issuer: 'RTO', year: 2020),
        ]).toJson(),
        <String, dynamic>{
          'field': 'certificates',
          'certificates': <dynamic>[
            <String, dynamic>{
              'name': 'Driving',
              'issuer': 'RTO',
              'year': 2020,
              'licence_number': null,
              'licence_expiry': null,
            },
          ],
        },
      );
    });

    test('response parses counts, never values', () {
      const CorrectionsApplied applied = CorrectionsApplied(
          profileId: 'p', correctionsApplied: 2, correctionCount: 7);
      expect(applied.correctionCount, 7);
      expect(
        CorrectionsApplied.fromJson(<String, dynamic>{
          'profile_id': 'p',
          'corrections_applied': 2,
          'correction_count': 7,
        }),
        applied,
      );
    });
  });

  group('correctionRejectedOf matches codes, never prose', () {
    test('cap code in the body message', () {
      expect(
        correctionRejectedOf(ApiException(409, 'x', body: <String, dynamic>{
          'message': '(20 lifetime corrections, correction_cap_reached).'
        })),
        CorrectionRejected.capReached,
      );
    });

    test('deferral code in the top message', () {
      expect(
        correctionRejectedOf(ApiException(
            409, 'see (unpinned_road_deferred).')),
        CorrectionRejected.unpinnedRoadDeferred,
      );
    });

    test('non-409 and unknown 409 read as other', () {
      expect(
        correctionRejectedOf(ApiException(400, 'bad')),
        CorrectionRejected.other,
      );
      expect(
        correctionRejectedOf(ApiException(409, 'something else')),
        CorrectionRejected.other,
      );
    });
  });
}
