import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

/// #1343 — GET /resume/document's response, parsed. The endpoint's OUTER
/// wrapper is snake_case (`resume_id`) like every other DTO; the nested
/// `document` is camelCase (written straight from the server's TS type), with
/// [ResumeEmploymentDto]'s `location_suffix` / `role_inline` riding snake_case
/// EVEN inside that camelCase document — see api_models.dart's file-level note.
void main() {
  group('ResumeDocumentResponse.fromJson', () {
    test('document: null is an ORDINARY answer, never a parse failure', () {
      final ResumeDocumentResponse response = ResumeDocumentResponse.fromJson(
        <String, dynamic>{
          'resume_id': 'r-1',
          'version': 3,
          'document': null,
        },
      );

      expect(response.resumeId, 'r-1');
      expect(response.version, 3);
      expect(response.document, isNull);
    });

    test('a missing `document` key ALSO parses to null (defensive, same as explicit null)', () {
      final ResumeDocumentResponse response = ResumeDocumentResponse.fromJson(
        <String, dynamic>{'resume_id': 'r-1', 'version': 1},
      );
      expect(response.document, isNull);
    });

    test('format: "generic" parses every flat field', () {
      final ResumeDocumentResponse response = ResumeDocumentResponse.fromJson(
        <String, dynamic>{
          'resume_id': 'r-2',
          'version': 1,
          'document': <String, dynamic>{
            'format': 'generic',
            'trade': null,
            'header': <String, dynamic>{
              'name': 'Ramesh Kumar',
              'phone': null,
              'trustBadge': null,
            },
            'footerMeta': 'Generated 29 August 2026 · Ref RK8M2Q',
            'headline': 'CNC Turner',
            'summary': 'Experienced CNC turner.',
            'location': 'Faridabad',
            'availability': 'Available now',
            'experienceYears': 8,
            'expectedSalary': 32000,
            'skills': <String>['Turning', 'Setting'],
            'machines': <String>['CNC lathe'],
            'controllers': <String>['Fanuc'],
            'education': <String>['ITI'],
            'certifications': <String>['NCVT'],
            'preferredLocations': <String>['Gurugram'],
            'experiences': <dynamic>[
              <String, dynamic>{
                'role': 'CNC Operator',
                'duration': '3 years',
                'work': 'Turning on CNC lathe',
              },
            ],
          },
        },
      );

      expect(response.document, isA<GenericResumeDocument>());
      final GenericResumeDocument doc =
          response.document! as GenericResumeDocument;
      expect(doc.header.name, 'Ramesh Kumar');
      expect(doc.footerMeta, 'Generated 29 August 2026 · Ref RK8M2Q');
      expect(doc.headline, 'CNC Turner');
      expect(doc.experienceYears, 8);
      expect(doc.expectedSalary, 32000);
      expect(doc.skills, <String>['Turning', 'Setting']);
      expect(doc.machines, <String>['CNC lathe']);
      expect(doc.controllers, <String>['Fanuc']);
      expect(doc.education, <String>['ITI']);
      expect(doc.certifications, <String>['NCVT']);
      expect(doc.preferredLocations, <String>['Gurugram']);
      expect(doc.experiences, hasLength(1));
      expect(doc.experiences.single.role, 'CNC Operator');
      expect(doc.experiences.single.duration, '3 years');
      expect(doc.experiences.single.work, 'Turning on CNC lathe');
    });

    test('an absent format defaults to generic (never a blank tab)', () {
      final ResumeDocument document = ResumeDocument.fromJson(
        <String, dynamic>{'header': <String, dynamic>{}},
      );
      expect(document, isA<GenericResumeDocument>());
    });

    test('format: "trade_sheet" parses header, headline, zoned sections, '
        'and employments (including snake_case employment fields)', () {
      final ResumeDocumentResponse response = ResumeDocumentResponse.fromJson(
        <String, dynamic>{
          'resume_id': 'r-3',
          'version': 2,
          'document': <String, dynamic>{
            'format': 'trade_sheet',
            'trade': 'cnc_turner',
            'header': <String, dynamic>{
              'name': 'Suresh Yadav',
              'phone': '+91 9876543210',
              'trustBadge': 'RVM-attested',
            },
            'footerMeta': 'Generated 29 August 2026 · Ref RK8M2Q',
            'headline': <String, dynamic>{
              'line1': 'CNC Turner · 8 yrs · Fanuc',
              'line2': 'Faridabad · Available now · expects ₹32,000',
            },
            'sections': <dynamic>[
              <String, dynamic>{
                'id': 'capability',
                'title': 'Capability',
                'chipRows': <dynamic>[
                  <String, dynamic>{
                    'label': 'Machines',
                    'values': <String>['CNC lathe'],
                  },
                ],
                'tickRows': <dynamic>[
                  <String, dynamic>{
                    'label': 'Setting',
                    'values': <String>['Tool offset'],
                  },
                ],
                'factRows': <dynamic>[
                  <String, dynamic>{
                    'label': 'Tolerance held',
                    'value': '±0.02 mm',
                  },
                ],
              },
              // An EMPTY section — the server keeps it rather than dropping it.
              <String, dynamic>{
                'id': 'terms',
                'title': 'Availability & terms',
                'chipRows': <dynamic>[],
                'tickRows': <dynamic>[],
                'factRows': <dynamic>[],
              },
            ],
            'employments': <dynamic>[
              <String, dynamic>{
                'id': 'emp-1',
                'employer': 'ABC Precision Ltd',
                'location_suffix': ' · Gurugram, Haryana',
                'role_inline': ' — CNC Turner',
                'when': 'Jan 2023 – Present · 3 yrs 6 mo',
                'work': 'Turning on CNC lathe.',
                'work_own_words': 'lathe pe shaft banata tha',
                'roles': <dynamic>[
                  <String, dynamic>{'role': 'Trainee', 'when': '2023'},
                ],
              },
            ],
            'employmentsMore': 'and 2 more',
          },
        },
      );

      expect(response.document, isA<TradeSheetResumeDocument>());
      final TradeSheetResumeDocument doc =
          response.document! as TradeSheetResumeDocument;

      expect(doc.trade, 'cnc_turner');
      expect(doc.header.name, 'Suresh Yadav');
      expect(doc.header.phone, '+91 9876543210');
      expect(doc.header.trustBadge, 'RVM-attested');
      expect(doc.headline.line1, 'CNC Turner · 8 yrs · Fanuc');
      expect(doc.headline.line2, 'Faridabad · Available now · expects ₹32,000');

      expect(doc.sections, hasLength(2));
      final ResumeDocumentSectionDto capability = doc.sections.first;
      expect(capability.id, 'capability');
      expect(capability.hasRows, isTrue);
      expect(capability.chipRows.single.label, 'Machines');
      expect(capability.chipRows.single.values, <String>['CNC lathe']);
      expect(capability.tickRows.single.label, 'Setting');
      expect(capability.tickRows.single.values, <String>['Tool offset']);
      expect(capability.factRows.single.label, 'Tolerance held');
      expect(capability.factRows.single.value, '±0.02 mm');

      final ResumeDocumentSectionDto terms = doc.sections.last;
      expect(terms.id, 'terms');
      expect(terms.hasRows, isFalse,
          reason: 'an empty zone is kept, not dropped — hasRows is how the '
              'client decides whether to show its heading');

      expect(doc.employments, hasLength(1));
      final ResumeEmploymentDto employment = doc.employments.single;
      expect(employment.id, 'emp-1');
      expect(employment.employer, 'ABC Precision Ltd');
      expect(employment.locationSuffix, ' · Gurugram, Haryana');
      expect(employment.roleInline, ' — CNC Turner');
      expect(employment.when, 'Jan 2023 – Present · 3 yrs 6 mo');
      expect(employment.work, 'Turning on CNC lathe.');
      expect(employment.workOwnWords, 'lathe pe shaft banata tha');
      expect(employment.hasOwnWordsToReveal, isTrue);
      expect(employment.roles.single.role, 'Trainee');
      expect(employment.roles.single.when, '2023');
      expect(doc.employmentsMore, 'and 2 more');
    });

    test('trade_sheet with missing optional arrays degrades to empty, never throws', () {
      final ResumeDocument document = ResumeDocument.fromJson(<String, dynamic>{
        'format': 'trade_sheet',
        'trade': 'welder',
        'header': <String, dynamic>{},
      });

      expect(document, isA<TradeSheetResumeDocument>());
      final TradeSheetResumeDocument doc = document as TradeSheetResumeDocument;
      expect(doc.sections, isEmpty);
      expect(doc.employments, isEmpty);
      expect(doc.employmentsMore, isNull);
      expect(doc.headline.line1, isNull);
      expect(doc.headline.line2, isNull);
    });
  });

  // #1353/#1354 — `id` and `work_own_words` are the two fields the reveal/keep-
  // own-words affordance needs; [ResumeEmploymentDto.hasOwnWordsToReveal] is the
  // ONLY signal the client uses to decide whether to show anything at all.
  group('ResumeEmploymentDto — id / work_own_words (#1353)', () {
    test('both absent parses to null, no crash — an ordinary pre-#1353 shape', () {
      final ResumeEmploymentDto e = ResumeEmploymentDto.fromJson(
        <String, dynamic>{'employer': 'ABC Ltd', 'work': 'Turning on CNC lathe.'},
      );
      expect(e.id, isNull);
      expect(e.workOwnWords, isNull);
      expect(e.hasOwnWordsToReveal, isFalse);
    });

    test('work_own_words EQUAL to work (never rewritten, or already declined) '
        '-> hasOwnWordsToReveal is false', () {
      final ResumeEmploymentDto e = ResumeEmploymentDto.fromJson(<String, dynamic>{
        'id': 'emp-1',
        'work': 'lathe pe shaft banata tha',
        'work_own_words': 'lathe pe shaft banata tha',
      });
      expect(e.hasOwnWordsToReveal, isFalse);
    });

    test('work_own_words DIFFERS from work (a genuine rewrite) -> '
        'hasOwnWordsToReveal is true', () {
      final ResumeEmploymentDto e = ResumeEmploymentDto.fromJson(<String, dynamic>{
        'id': 'emp-1',
        'work': 'Operated CNC lathe for precision shaft turning.',
        'work_own_words': 'lathe pe shaft banata tha',
      });
      expect(e.id, 'emp-1');
      expect(e.hasOwnWordsToReveal, isTrue);
    });

    test('work_own_words present but work absent (defaults to "") still compares honestly', () {
      final ResumeEmploymentDto e = ResumeEmploymentDto.fromJson(<String, dynamic>{
        'id': 'emp-1',
        'work_own_words': 'lathe pe shaft banata tha',
      });
      expect(e.work, '');
      expect(e.hasOwnWordsToReveal, isTrue);
    });
  });
}
