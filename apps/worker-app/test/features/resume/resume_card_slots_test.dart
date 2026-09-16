import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_card_slots.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_sections.dart';

import 'resume_document_fixtures.dart';

/// Every string the mapper can put on screen, flattened — so a raw-id
/// assertion covers the whole output rather than the one field a test
/// happened to look at.
List<String> _allStrings(ResumeSlots s) => <String>[
  if (s.capabilityTitle != null) s.capabilityTitle!,
  ...s.machines,
  if (s.machinesLabel != null) s.machinesLabel!,
  ...s.controllers,
  if (s.controllersLabel != null) s.controllersLabel!,
  ...s.materials,
  if (s.materialsTitle != null) s.materialsTitle!,
  ...s.operations,
  if (s.operationsTitle != null) s.operationsTitle!,
  ...s.workholding,
  for (final ResumeValueGroup g in s.instrumentGroups) ...<String>[
    g.label,
    ...g.values,
  ],
  for (final ResumeValueGroup g in s.otherGroups) ...<String>[
    g.label,
    ...g.values,
  ],
  for (final ResumeFact f in s.otherFacts) ...<String>[f.label, f.value],
  if (s.drawingReading != null) s.drawingReading!,
  if (s.salary != null) s.salary!,
  for (final ResumeExtraSection e in s.extraSections) ...<String>[
    e.title,
    for (final ResumeValueGroup g in e.chipGroups) ...<String>[
      g.label,
      ...g.values,
    ],
    for (final ResumeValueGroup g in e.tickGroups) ...<String>[
      g.label,
      ...g.values,
    ],
    for (final ResumeFact f in e.facts) ...<String>[f.label, f.value],
  ],
];

void main() {
  group('mapTradeSheet — a turner, by row key', () {
    late ResumeSlots slots;

    setUp(() => slots = mapTradeSheet(kTurnerSheet));

    test('machines and controllers land in the capability card', () {
      expect(slots.machines, <String>[
        'CNC lathe / turning centre',
        'Conventional lathe',
      ]);
      expect(slots.controllers, <String>['Fanuc Oi-TF', 'Siemens 828D']);
      expect(slots.hasCapabilityCard, isTrue);
      // The count pill is the REAL total, digits only (R8).
      expect(slots.capabilityCount, 4);
    });

    test('the card title is the SERVER\'s zone title, not the spec\'s '
        'turner-only wording', () {
      expect(slots.capabilityTitle, 'Machines, controllers & capability');
      expect(slots.capabilityTitle, isNot(contains('CNC Controllers')));
    });

    test('materials get their own card, titled by the server\'s row label', () {
      expect(slots.materials, <String>[
        'Mild steel',
        'Brass',
        'Aluminium',
        'EN8',
      ]);
      expect(slots.materialsTitle, 'Materials');
      expect(slots.hasMaterialsCard, isTrue);
    });

    test('operations, workholding and instruments each find their slot', () {
      expect(slots.operations, <String>['Turning', 'Threading', 'Boring']);
      expect(slots.workholding, <String>['3-jaw chuck', 'Collet']);
      expect(slots.instrumentGroups, hasLength(1));
      expect(slots.instrumentGroups.single.label, 'Measuring instruments');
      expect(slots.instrumentGroups.single.values, <String>[
        'Micrometer',
        'Vernier caliper',
      ]);
      expect(slots.hasOperationsCard, isTrue);
    });

    test('the drawing fact becomes the callout, and keeps the server\'s own '
        'wording', () {
      expect(slots.drawingReading, 'Reads 2D drawings and GD&T');
    });

    test('a key the v3 cards do NOT model is still rendered, under its own '
        'label — nothing is ever dropped', () {
      final ResumeValueGroup setting = slots.otherGroups.firstWhere(
        (ResumeValueGroup g) => g.label == 'Setting',
      );
      expect(setting.values, <String>['Tool offset setting', 'Job centering']);
      expect(setting.tick, isTrue, reason: 'it was a tickRow on the sheet');
    });

    test('a capability FACT that is not the drawing row stays in the card', () {
      expect(
        slots.otherFacts.map((ResumeFact f) => '${f.label}: ${f.value}'),
        contains('Tolerance held: ±0.02 mm'),
      );
    });

    test('the salary is LIFTED into the profile card and removed from the '
        'terms zone, so one number is not printed twice', () {
      expect(slots.salary, '₹24,000 – ₹28,000 / month');
      final ResumeExtraSection terms = slots.extraSections.firstWhere(
        (ResumeExtraSection e) => e.id == 'terms',
      );
      expect(
        terms.facts.map((ResumeFact f) => f.label),
        isNot(contains('Salary expected')),
      );
      // The zone's OTHER facts are untouched.
      expect(
        terms.facts.map((ResumeFact f) => f.label),
        containsAll(<String>['Available from', 'Shift']),
      );
    });

    test('zones the spec omits survive as their own cards', () {
      expect(
        slots.extraSections.map((ResumeExtraSection e) => e.id),
        containsAllInOrder(<String>['terms', 'qualifications']),
      );
    });

    test('an EMPTY zone is dropped — a content-less heading is not a card', () {
      expect(
        slots.extraSections.map((ResumeExtraSection e) => e.id),
        isNot(contains('extras')),
      );
    });

    test('NO RAW IDS anywhere in the output', () {
      final String joined = _allStrings(slots).join(' | ');
      for (final String slug in <String>[
        'cnc_turner',
        'turning_machine',
        'controller_brand',
        'material_worked',
        'drawing_reading',
        'setting_operation',
        'below_10',
      ]) {
        expect(joined, isNot(contains(slug)), reason: 'raw id leaked: $slug');
      }
    });
  });

  group('mapTradeSheet — hide rules', () {
    late ResumeSlots slots;

    setUp(() => slots = mapTradeSheet(kSparseSheet));

    test('no material rows → no materials card', () {
      expect(slots.materials, isEmpty);
      expect(slots.hasMaterialsCard, isFalse);
    });

    test('no controller row → nothing to put under CONTROLLERS KNOWN', () {
      expect(slots.controllers, isEmpty);
      // The card still stands, because there ARE machines.
      expect(slots.hasCapabilityCard, isTrue);
    });

    test('no drawing row → no callout', () {
      expect(slots.drawingReading, isNull);
    });

    test('no salary row → no salary box', () {
      expect(slots.salary, isNull);
    });

    test('nothing for the operations card → it is not built', () {
      expect(slots.hasOperationsCard, isFalse);
    });

    test(
      'a document with no sections at all yields an empty, harmless map',
      () {
        final ResumeSlots empty = mapTradeSheet(
          const TradeSheetResumeDocument(
            header: ResumeDocumentHeaderDto(),
            trade: 'cnc_turner',
          ),
        );
        expect(empty.hasCapabilityCard, isFalse);
        expect(empty.hasMaterialsCard, isFalse);
        expect(empty.hasOperationsCard, isFalse);
        expect(empty.extraSections, isEmpty);
        expect(empty.salary, isNull);
      },
    );
  });

  group('mapTradeSheet — a welder, the trade-agnostic proof', () {
    late ResumeSlots slots;

    setUp(() => slots = mapTradeSheet(kWelderSheet));

    test('the electrode row is MATERIALS, titled as the server named it — not '
        '"Alloys"', () {
      expect(slots.materials, <String>['E6013', 'E7018']);
      expect(slots.materialsTitle, 'Electrodes');
      expect(slots.materialsTitle, isNot(contains('Alloy')));
    });

    test('unknown keys keep their own labels instead of vanishing', () {
      expect(
        slots.otherGroups.map((ResumeValueGroup g) => g.label),
        containsAll(<String>['Processes', 'Positions']),
      );
      expect(
        slots.otherGroups
            .firstWhere((ResumeValueGroup g) => g.label == 'Processes')
            .values,
        <String>['MIG', 'TIG', 'Arc'],
      );
    });

    test('an unknown FACT key still prints', () {
      expect(
        slots.otherFacts.map((ResumeFact f) => '${f.label}: ${f.value}'),
        contains('Plate: 6 mm'),
      );
    });

    test('a welder has no turner machines, so that card does not appear', () {
      expect(slots.machines, isEmpty);
      expect(slots.hasCapabilityCard, isFalse);
      // …but every row still reached the screen, through the other card.
      expect(slots.hasOperationsCard, isTrue);
    });
  });

  group('mapTradeSheet — a keyless (pre-key) document', () {
    test('rows with NO key are kept under their labels, never dropped', () {
      final ResumeSlots slots = mapTradeSheet(
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'capability',
              title: 'Capability',
              chipRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  label: 'Machines',
                  values: <String>['CNC lathe'],
                ),
              ],
            ),
          ],
        ),
      );

      expect(slots.machines, isEmpty, reason: 'no key, so no slot match');
      expect(slots.otherGroups.single.label, 'Machines');
      expect(slots.otherGroups.single.values, <String>['CNC lathe']);
      expect(
        slots.hasOperationsCard,
        isTrue,
        reason: 'the catch-all card carries it, so nothing is lost',
      );
    });
  });

  // ── The chips-vs-rows decision, decided from the VALUES ─────────────────
  //
  // The sheet's `tick` flag used to decide it, which cost every short-value
  // group ('Measuring instruments', 'Setting', 'Documents ready') a stack of
  // full-width rows. The flag is still carried — it describes the row the
  // server sent — but the DATA decides the drawing.
  group('valuesReadAsChips — the space rule', () {
    String ofLength(int n) => List<String>.filled(n, 'a').join();

    test('short values read as chips', () {
      expect(valuesReadAsChips(<String>['Micrometer', 'Vernier caliper']), isTrue);
      expect(valuesReadAsChips(<String>['Aadhaar', 'PAN', 'UAN']), isTrue);
      // The longest value the server actually sends today.
      expect(valuesReadAsChips(<String>['CNC lathe / turning centre']), isTrue);
    });

    test('the threshold is inclusive, and one char past it flips the group', () {
      expect(valuesReadAsChips(<String>[ofLength(kChipValueMaxChars)]), isTrue);
      expect(
        valuesReadAsChips(<String>[ofLength(kChipValueMaxChars + 1)]),
        isFalse,
      );
      // Surrounding whitespace is not length — the mapper trims before this.
      expect(
        valuesReadAsChips(<String>['  ${ofLength(kChipValueMaxChars)}  ']),
        isTrue,
      );
    });

    test('ONE long value sends the whole group to rows', () {
      expect(
        valuesReadAsChips(<String>[
          'Micrometer',
          'Reads 2D drawings and GD&T symbols on turned components',
        ]),
        isFalse,
      );
    });

    test('a group carries its own answer, and never asks the tick flag', () {
      const ResumeValueGroup ticked = ResumeValueGroup(
        label: 'Documents ready',
        values: <String>['Aadhaar', 'PAN'],
        tick: true,
      );
      expect(ticked.tick, isTrue, reason: 'the server\'s own styling, kept');
      expect(ticked.readsAsChips, isTrue, reason: 'but the data decides');

      const ResumeValueGroup sentences = ResumeValueGroup(
        label: 'Inspection work',
        values: <String>['Reads 2D drawings and GD&T symbols on turned parts'],
      );
      expect(sentences.tick, isFalse);
      expect(sentences.readsAsChips, isFalse);
    });

    test('an empty group asks for chips and draws nothing — no padded row', () {
      const ResumeValueGroup empty = ResumeValueGroup(
        label: 'Documents ready',
        values: <String>[],
      );
      expect(empty.isEmpty, isTrue);
      expect(empty.readsAsChips, isTrue);
    });

    test('the real sheet\'s tick groups all became chips — the owner\'s '
        'complaint, at the mapper level', () {
      final ResumeSlots slots = mapTradeSheet(kTurnerSheet);
      expect(slots.instrumentGroups.single.readsAsChips, isTrue);
      for (final ResumeValueGroup g in slots.otherGroups) {
        expect(g.readsAsChips, isTrue, reason: '${g.label} should pack');
      }
      for (final ResumeExtraSection e in slots.extraSections) {
        for (final ResumeValueGroup g in e.tickGroups) {
          expect(g.readsAsChips, isTrue, reason: '${g.label} should pack');
        }
      }
    });
  });

  group('resolveProfileFacts', () {
    ParsedResume parse(String text) => parseResumeText(text);

    test('a trade sheet uses the server\'s pre-composed masthead VERBATIM', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: kTurnerSheet,
        parsed: parse(''),
      );

      expect(facts.subtitle, 'CNC Turner · 8 yrs · Fanuc · 2-axis');
      // The city/availability line has no spec slot but carries real data, so
      // it is kept rather than dropped.
      expect(facts.secondLine, 'Faridabad · Available now · expects ₹32,000');
      expect(facts.salary, '₹24,000 – ₹28,000 / month');
    });

    test('a generic document composes its own line and formats its NUMERIC '
        'salary Indian-style', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: const GenericResumeDocument(
          header: ResumeDocumentHeaderDto(),
          headline: 'VMC Operator',
          experienceYears: 6,
          controllers: <String>['Fanuc', 'Siemens', 'Mitsubishi', 'Haas'],
          location: 'Pune',
          availability: 'Available now',
          expectedSalary: 125000,
        ),
        parsed: parse(''),
      );

      expect(
        facts.subtitle,
        'VMC Operator · 6 saal · Fanuc · Siemens · Mitsubishi',
      );
      expect(facts.secondLine, 'Pune · Available now');
      expect(facts.salary, '₹1,25,000 / month');
    });

    test('a generic document with no salary hides the box rather than '
        'printing ₹0', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: const GenericResumeDocument(
          header: ResumeDocumentHeaderDto(),
          expectedSalary: 0,
        ),
        parsed: parse(''),
      );
      expect(facts.salary, isNull);
      expect(facts.subtitle, isNull);
    });

    test('with no document at all the parsed resume text answers', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: null,
        parsed: parse('''WORKER PROFILE (DRAFT)

Role: HMC Operator
Trade: HMC Machining
Experience: 10 years
Current location: Faridabad
Expected salary: 20000 per month'''),
      );

      expect(facts.subtitle, 'HMC Operator · HMC Machining · 10 years');
      expect(facts.secondLine, 'Faridabad');
      // The text carries a bare number ('20000 per month' — extraction.py
      // prints it with a plain `:.0f`); the money box shows it the way money
      // is shown everywhere else in the app.
      expect(facts.salary, '₹20,000 / month');
    });

    test('a salary the SERVER already formatted is printed verbatim — only a '
        'bare number is reformatted', () {
      String? salaryFrom(String line) => resolveProfileFacts(
        document: null,
        parsed: parse('Role: Fitter\n$line'),
      ).salary;

      // Already composed by the server: not touched.
      expect(
        salaryFrom('Expected salary: ₹24,000 – ₹28,000 / month'),
        '₹24,000 – ₹28,000 / month',
      );
      // A word, not a number: not touched, not dropped.
      expect(salaryFrom('Expected salary: Negotiable'), 'Negotiable');
      // No period stated → none invented.
      expect(salaryFrom('Expected salary: 18000'), '₹18,000');
    });

    test('an empty resume yields no lines at all — nothing is invented', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: null,
        parsed: parse(''),
      );
      expect(facts.subtitle, isNull);
      expect(facts.secondLine, isNull);
      expect(facts.salary, isNull);
    });

    test('a raw education token never survives into a fact value', () {
      final ResumeSlots slots = mapTradeSheet(
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'qualifications',
              title: 'Qualification',
              factRows: <ResumeFactRowDto>[
                ResumeFactRowDto(label: 'Education', value: 'below_10'),
              ],
            ),
          ],
        ),
      );

      final ResumeFact education = slots.extraSections.single.facts.single;
      expect(education.value, '10th se kam');
      expect(education.value, isNot(contains('below_10')));
    });

    test('a taxonomy id in a server value is resolved to its label', () {
      final ResumeSlots slots = mapTradeSheet(
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'capability',
              title: 'Capability',
              chipRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  key: 'turning_machine',
                  label: 'Machines',
                  values: <String>['mach_cnc_lathe'],
                ),
              ],
            ),
          ],
        ),
      );

      expect(slots.machines, <String>['CNC Lathe / Turning Center']);
    });
  });
}
