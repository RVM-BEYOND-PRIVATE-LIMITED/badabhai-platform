import 'package:badabhai_worker_app/core/api/api_models.dart';

/// A REALISTIC `format: "trade_sheet"` document, shaped exactly as apps/api
/// sends one: every capability row carries its `key` and `rank`, the terms and
/// qualification zones carry fact rows with NO key at all (backend gap B7),
/// and the masthead is pre-composed with the server's own ` · ` separators.
///
/// Shared by the slot-mapper, data-rule and responsive suites so all three
/// judge the same document. The values are deliberately LONG where a real
/// worker's are long ('CNC lathe / turning centre', 'Fanuc Oi-TF') — that is
/// what makes the narrow-screen assertions mean anything.
const TradeSheetResumeDocument kTurnerSheet = TradeSheetResumeDocument(
  header: ResumeDocumentHeaderDto(
    name: 'Suresh Yadav',
    trustBadge: 'BadaBhai Verified',
  ),
  trade: 'cnc_turner',
  headline: ResumeSheetHeadlineDto(
    line1: 'CNC Turner · 8 yrs · Fanuc · 2-axis',
    line2: 'Faridabad · Available now · expects ₹32,000',
  ),
  footerMeta: 'Generated 29 August 2026 · Ref RK8M2Q',
  sections: <ResumeDocumentSectionDto>[
    ResumeDocumentSectionDto(
      id: 'capability',
      title: 'Machines, controllers & capability',
      chipRows: <ResumeListRowDto>[
        ResumeListRowDto(
          key: 'turning_machine',
          rank: 1,
          label: 'Machines',
          values: <String>['CNC lathe / turning centre', 'Conventional lathe'],
        ),
        ResumeListRowDto(
          key: 'controller_brand',
          rank: 2,
          label: 'Controllers',
          values: <String>['Fanuc Oi-TF', 'Siemens 828D'],
        ),
        ResumeListRowDto(
          key: 'material_worked',
          rank: 3,
          label: 'Materials',
          values: <String>['Mild steel', 'Brass', 'Aluminium', 'EN8'],
        ),
      ],
      tickRows: <ResumeListRowDto>[
        ResumeListRowDto(
          key: 'turning_operation',
          rank: 4,
          label: 'Operations',
          values: <String>['Turning', 'Threading', 'Boring'],
        ),
        ResumeListRowDto(
          key: 'workholding',
          rank: 5,
          label: 'Workholding',
          values: <String>['3-jaw chuck', 'Collet'],
        ),
        ResumeListRowDto(
          key: 'measuring_tools',
          rank: 6,
          label: 'Measuring instruments',
          values: <String>['Micrometer', 'Vernier caliper'],
        ),
        // A key the v3 card slots do NOT model — it must still render.
        ResumeListRowDto(
          key: 'setting_operation',
          rank: 7,
          label: 'Setting',
          values: <String>['Tool offset setting', 'Job centering'],
        ),
      ],
      factRows: <ResumeFactRowDto>[
        ResumeFactRowDto(
          key: 'drawing_reading',
          rank: 8,
          label: 'Drawings',
          value: 'Reads 2D drawings and GD&T',
        ),
        ResumeFactRowDto(
          key: 'tolerance_band',
          rank: 9,
          label: 'Tolerance held',
          value: '±0.02 mm',
        ),
      ],
    ),
    // NOTE: no keys on these — the server pushes them as plain label/value.
    ResumeDocumentSectionDto(
      id: 'terms',
      title: 'Availability & terms',
      factRows: <ResumeFactRowDto>[
        ResumeFactRowDto(label: 'Available from', value: 'Immediately'),
        ResumeFactRowDto(
          label: 'Salary expected',
          value: '₹24,000 – ₹28,000 / month',
        ),
        ResumeFactRowDto(label: 'Shift', value: 'Any shift'),
      ],
    ),
    ResumeDocumentSectionDto(
      id: 'qualifications',
      title: 'Qualification, documents & languages',
      factRows: <ResumeFactRowDto>[
        ResumeFactRowDto(label: 'Education', value: 'ITI'),
        ResumeFactRowDto(label: 'Languages spoken', value: 'Hindi, English'),
      ],
    ),
    // An empty zone: the server keeps it rather than dropping it, and the
    // client decides not to show a content-less heading.
    ResumeDocumentSectionDto(id: 'extras', title: 'Extras'),
  ],
  employments: <ResumeEmploymentDto>[
    ResumeEmploymentDto(
      id: 'emp-1',
      employer: 'ABC Precision Ltd',
      locationSuffix: ' · Gurugram, Haryana',
      roleInline: ' — CNC Turner',
      when: 'Jan 2023 – Present · 3 yrs 6 mo',
      work: 'Turning shafts and bushes on CNC lathe to drawing.',
    ),
    ResumeEmploymentDto(
      id: 'emp-2',
      employer: 'Sanaya Technology',
      when: 'Jan 2021 – Dec 2022',
      work: 'Ran production batches on conventional lathe.',
    ),
  ],
  employmentsMore: 'and 2 more',
);

/// The same worker with the pieces the v3 cards hide when absent: no
/// materials, no controllers, no drawing-reading fact and no salary row.
const TradeSheetResumeDocument kSparseSheet = TradeSheetResumeDocument(
  header: ResumeDocumentHeaderDto(),
  trade: 'cnc_turner',
  headline: ResumeSheetHeadlineDto(line1: 'CNC Turner · 2 yrs'),
  sections: <ResumeDocumentSectionDto>[
    ResumeDocumentSectionDto(
      id: 'capability',
      title: 'Machines, controllers & capability',
      chipRows: <ResumeListRowDto>[
        ResumeListRowDto(
          key: 'turning_machine',
          label: 'Machines',
          values: <String>['Conventional lathe'],
        ),
      ],
    ),
    ResumeDocumentSectionDto(
      id: 'terms',
      title: 'Availability & terms',
      factRows: <ResumeFactRowDto>[
        ResumeFactRowDto(label: 'Shift', value: 'Day shift'),
      ],
    ),
  ],
);

/// A welder's sheet: the SAME zone, entirely different keys and labels. The
/// point of the fixture is that the cards must not be turner-shaped — this is
/// what would break if a slot were chosen by matching the English label.
const TradeSheetResumeDocument kWelderSheet = TradeSheetResumeDocument(
  header: ResumeDocumentHeaderDto(),
  trade: 'welder',
  headline: ResumeSheetHeadlineDto(line1: 'Welder · 5 yrs · MIG'),
  sections: <ResumeDocumentSectionDto>[
    ResumeDocumentSectionDto(
      id: 'capability',
      title: 'Processes, positions & capability',
      chipRows: <ResumeListRowDto>[
        ResumeListRowDto(
          key: 'electrode_type',
          label: 'Electrodes',
          values: <String>['E6013', 'E7018'],
        ),
        // A key this build has never heard of.
        ResumeListRowDto(
          key: 'welding_process',
          label: 'Processes',
          values: <String>['MIG', 'TIG', 'Arc'],
        ),
      ],
      tickRows: <ResumeListRowDto>[
        ResumeListRowDto(
          key: 'welding_position',
          label: 'Positions',
          values: <String>['Flat', 'Vertical'],
        ),
      ],
      factRows: <ResumeFactRowDto>[
        ResumeFactRowDto(key: 'plate_thickness', label: 'Plate', value: '6 mm'),
      ],
    ),
  ],
);
