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
        <String, dynamic>{'resume_id': 'r-1', 'version': 3, 'document': null},
      );

      expect(response.resumeId, 'r-1');
      expect(response.version, 3);
      expect(response.document, isNull);
    });

    test(
      'a missing `document` key ALSO parses to null (defensive, same as explicit null)',
      () {
        final ResumeDocumentResponse response = ResumeDocumentResponse.fromJson(
          <String, dynamic>{'resume_id': 'r-1', 'version': 1},
        );
        expect(response.document, isNull);
      },
    );

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
      final ResumeDocument document = ResumeDocument.fromJson(<String, dynamic>{
        'header': <String, dynamic>{},
      });
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
      expect(
        terms.hasRows,
        isFalse,
        reason:
            'an empty zone is kept, not dropped — hasRows is how the '
            'client decides whether to show its heading',
      );

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

    test(
      'trade_sheet with missing optional arrays degrades to empty, never throws',
      () {
        final ResumeDocument document = ResumeDocument.fromJson(
          <String, dynamic>{
            'format': 'trade_sheet',
            'trade': 'welder',
            'header': <String, dynamic>{},
          },
        );

        expect(document, isA<TradeSheetResumeDocument>());
        final TradeSheetResumeDocument doc =
            document as TradeSheetResumeDocument;
        expect(doc.sections, isEmpty);
        expect(doc.employments, isEmpty);
        expect(doc.employmentsMore, isNull);
        expect(doc.headline.line1, isNull);
        expect(doc.headline.line2, isNull);
      },
    );
  });

  // The PDF's real state, and the row provenance the v3 resume tab uses to
  // choose a card. All four fields are ADDITIVE and nullable: a server that
  // does not send them must parse exactly as it did before.
  group('render_status / rendered_at (ruling R6)', () {
    test(
      'render_status "rendered" + rendered_at parse, and isRendered is true',
      () {
        final ResumeDocumentResponse response =
            ResumeDocumentResponse.fromJson(<String, dynamic>{
              'resume_id': 'r-9',
              'version': 4,
              'document': null,
              'render_status': 'rendered',
              'rendered_at': '2026-09-15T10:20:30.000Z',
            });

        expect(response.renderStatus, 'rendered');
        expect(response.isRendered, isTrue);
        expect(response.renderedAt, DateTime.parse('2026-09-15T10:20:30.000Z'));
      },
    );

    test('pending / failed / an UNRECOGNISED value are all "not rendered" '
        '— the pill fails closed', () {
      for (final String status in <String>['pending', 'failed', 'weird_new']) {
        final ResumeDocumentResponse response = ResumeDocumentResponse.fromJson(
          <String, dynamic>{
            'resume_id': 'r-9',
            'version': 1,
            'render_status': status,
          },
        );
        expect(response.renderStatus, status);
        expect(
          response.isRendered,
          isFalse,
          reason: 'only "rendered" may claim the PDF is ready ($status)',
        );
        expect(response.renderedAt, isNull);
      }
    });

    test('BOTH ABSENT parses to null — an older server is not "ready"', () {
      final ResumeDocumentResponse response = ResumeDocumentResponse.fromJson(
        <String, dynamic>{'resume_id': 'r-9', 'version': 1},
      );

      expect(response.renderStatus, isNull);
      expect(response.renderedAt, isNull);
      expect(response.isRendered, isFalse);
    });

    test('an UNPARSEABLE rendered_at degrades to null, never throws away the '
        'whole response', () {
      final ResumeDocumentResponse response =
          ResumeDocumentResponse.fromJson(<String, dynamic>{
            'resume_id': 'r-9',
            'version': 1,
            'render_status': 'rendered',
            'rendered_at': 'yesterday',
          });

      expect(response.renderedAt, isNull);
      expect(
        response.isRendered,
        isTrue,
        reason: 'a broken timestamp must not unset the status beside it',
      );
    });
  });

  group('row key / rank (the v3 card mapping)', () {
    test('a list row parses key + rank, and both are null when absent', () {
      final ResumeListRowDto withKey = ResumeListRowDto.fromJson(
        <String, dynamic>{
          'label': 'Machines',
          'values': <String>['CNC lathe'],
          'key': 'turning_machine',
          'rank': 3,
        },
      );
      expect(withKey.key, 'turning_machine');
      expect(withKey.rank, 3);

      final ResumeListRowDto without = ResumeListRowDto.fromJson(
        <String, dynamic>{
          'label': 'Machines',
          'values': <String>['CNC lathe'],
        },
      );
      expect(without.key, isNull);
      expect(without.rank, isNull);
      expect(
        without.label,
        'Machines',
        reason: 'the pre-existing fields parse exactly as before',
      );
    });

    test('a fact row parses key + rank, and both are null when absent — the '
        'COMMON case for terms/qualification rows', () {
      final ResumeFactRowDto withKey =
          ResumeFactRowDto.fromJson(<String, dynamic>{
            'label': 'Drawing reading',
            'value': 'Reads 2D drawings',
            'key': 'drawing_reading',
            'rank': 7,
          });
      expect(withKey.key, 'drawing_reading');
      expect(withKey.rank, 7);

      final ResumeFactRowDto without = ResumeFactRowDto.fromJson(
        <String, dynamic>{
          'label': 'Salary expected',
          'value': '₹24,000 – ₹28,000 / month',
        },
      );
      expect(without.key, isNull);
      expect(without.rank, isNull);
      expect(without.value, '₹24,000 – ₹28,000 / month');
    });

    test('a rank sent as a JSON double still reads as an int', () {
      final ResumeListRowDto row = ResumeListRowDto.fromJson(<String, dynamic>{
        'label': 'Machines',
        'rank': 2.0,
      });
      expect(row.rank, 2);
    });

    test('key + rank ride through a whole trade_sheet document', () {
      final ResumeDocument document = ResumeDocument.fromJson(<String, dynamic>{
        'format': 'trade_sheet',
        'trade': 'cnc_turner',
        'header': <String, dynamic>{},
        'sections': <dynamic>[
          <String, dynamic>{
            'id': 'capability',
            'title': 'Machines, controllers & capability',
            'chipRows': <dynamic>[
              <String, dynamic>{
                'label': 'Machines run',
                'values': <String>['CNC lathe'],
                'key': 'turning_machine',
                'rank': 1,
              },
            ],
            'factRows': <dynamic>[
              <String, dynamic>{
                'label': 'Drawing reading',
                'value': 'Reads 2D drawings',
                'key': 'drawing_reading',
              },
            ],
          },
        ],
      });

      final TradeSheetResumeDocument doc = document as TradeSheetResumeDocument;
      expect(doc.sections.single.chipRows.single.key, 'turning_machine');
      expect(doc.sections.single.chipRows.single.rank, 1);
      expect(doc.sections.single.factRows.single.key, 'drawing_reading');
    });
  });

  // #1353/#1354 — `id` and `work_own_words` are the two fields the reveal/keep-
  // own-words affordance needs; [ResumeEmploymentDto.hasOwnWordsToReveal] is the
  // ONLY signal the client uses to decide whether to show anything at all.
  group('ResumeEmploymentDto — id / work_own_words (#1353)', () {
    test(
      'both absent parses to null, no crash — an ordinary pre-#1353 shape',
      () {
        final ResumeEmploymentDto e = ResumeEmploymentDto.fromJson(
          <String, dynamic>{
            'employer': 'ABC Ltd',
            'work': 'Turning on CNC lathe.',
          },
        );
        expect(e.id, isNull);
        expect(e.workOwnWords, isNull);
        expect(e.hasOwnWordsToReveal, isFalse);
      },
    );

    test('work_own_words EQUAL to work (never rewritten, or already declined) '
        '-> hasOwnWordsToReveal is false', () {
      final ResumeEmploymentDto e =
          ResumeEmploymentDto.fromJson(<String, dynamic>{
            'id': 'emp-1',
            'work': 'lathe pe shaft banata tha',
            'work_own_words': 'lathe pe shaft banata tha',
          });
      expect(e.hasOwnWordsToReveal, isFalse);
    });

    test('work_own_words DIFFERS from work (a genuine rewrite) -> '
        'hasOwnWordsToReveal is true', () {
      final ResumeEmploymentDto e =
          ResumeEmploymentDto.fromJson(<String, dynamic>{
            'id': 'emp-1',
            'work': 'Operated CNC lathe for precision shaft turning.',
            'work_own_words': 'lathe pe shaft banata tha',
          });
      expect(e.id, 'emp-1');
      expect(e.hasOwnWordsToReveal, isTrue);
    });

    test(
      'work_own_words present but work absent (defaults to "") still compares honestly',
      () {
        final ResumeEmploymentDto e = ResumeEmploymentDto.fromJson(
          <String, dynamic>{
            'id': 'emp-1',
            'work_own_words': 'lathe pe shaft banata tha',
          },
        );
        expect(e.work, '');
        expect(e.hasOwnWordsToReveal, isTrue);
      },
    );
  });
}
