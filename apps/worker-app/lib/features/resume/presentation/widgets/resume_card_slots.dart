/// PURE mapping from a resume document to the UI kit v3 card slots (spec §4).
///
/// ── WHY A MAPPER AND NOT `if (label == 'Machines')` ─────────────────────────
///
/// Spec §4 draws a turner's resume: "Machines & CNC Controllers", "Materials
/// Handled", "Turning Operations & Tooling". The real server sends ONE zoned
/// `capability` section per trade, whose row LABELS are trade-specific — a
/// welder's chip row is "Processes", a powder coater's material row is
/// "Coating materials". Keying the cards off English label text would have
/// silently emptied every non-turner worker's resume tab.
///
/// So the slots are chosen by each row's `key` (the attribute id, now parsed —
/// see [ResumeListRowDto.key]), and the CARD TITLES come from the server's own
/// labels rather than from the spec's turner wording. Nothing here invents a
/// title, a count or a category.
///
/// ── NOTHING IS EVER DROPPED ─────────────────────────────────────────────────
///
/// A row whose key this build does not recognise, or that has no key at all,
/// still renders — under its own label, in [ResumeSlots.otherGroups] /
/// [ResumeSlots.otherFacts] or as an [ResumeExtraSection]. That is the
/// existing renderer's rule (`hasRows`, the legacy "More" bucket) and it
/// holds here: the worker must see every line the server actually produced,
/// because they are the only person who can tell us a line is wrong.
///
/// Everything returned has already been through [replaceTaxonomyIds] (and
/// education values through [humanizeEducationLevel]), so no raw taxonomy id
/// or `below_10`-style token can reach the screen.
library;

import '../../../../core/api/api_models.dart';
import '../../../../core/util/education_label.dart';
import '../../../../core/util/pay_format.dart';
import '../../../../core/util/taxonomy_labels.dart';
import 'resume_sections.dart';

// ── The key → slot table (spec §4, plan §6.2) ──────────────────────────────
//
// Keys come from apps/api `trade-resume-map.ts`. They are RAW SLUGS used only
// to pick a slot; not one of them is ever rendered.

/// Chip rows that are MACHINES the worker has operated.
const Set<String> kMachineRowKeys = <String>{
  'turning_machine',
  'milling_machine',
  'grinding_machine',
  'machining_machine',
  'toolroom_machine',
};

/// The controller-brand chip row, drawn as full-width rows instead of chips:
/// "Fanuc Oi-TF" style values are too long to read as pills.
const String kControllerRowKey = 'controller_brand';

/// Rows that are MATERIALS. Deliberately several keys: the same slot is
/// "materials worked" for a machinist, "tool steels" for a tool & die maker,
/// "electrode types" for a welder and "coating materials" for a powder coater.
const Set<String> kMaterialRowKeys = <String>{
  'material_worked',
  'tool_steel',
  'electrode_type',
  'coating_material',
};

/// Rows that are the trade's core OPERATIONS.
const Set<String> kOperationRowKeys = <String>{
  'turning_operation',
  'milling_operation',
  'machining_operation',
};

const String kWorkholdingRowKey = 'workholding';

/// Measuring and inspection rows.
const Set<String> kInstrumentRowKeys = <String>{
  'measuring_tools',
  'quality_work',
  'inspection_work',
};

/// The fact row behind the drawing-reading callout.
const String kDrawingReadingRowKey = 'drawing_reading';

/// The zone id that carries the trade's capability rows.
const String kCapabilitySectionId = 'capability';

/// The English label the server gives the expected-salary fact row.
///
/// Matched as a STRING because those fact rows carry no key at all — the
/// terms/qualification zones build them through a plain `push(rows, label,
/// value)` (backend gap B7). Kept case-insensitive and exported so the test
/// pins the exact coupling rather than leaving it implicit.
const String kSalaryFactLabel = 'Salary expected';

/// A labelled group of values, rendered as chips or as check rows.
class ResumeValueGroup {
  const ResumeValueGroup({
    required this.label,
    required this.values,
    this.tick = false,
  });

  final String label;
  final List<String> values;

  /// True when the server printed this row as a ✓ list rather than pills.
  final bool tick;

  bool get isEmpty => values.isEmpty;
}

/// One `label: value` fact.
class ResumeFact {
  const ResumeFact({required this.label, required this.value});

  final String label;
  final String value;
}

/// A zone the spec's four cards do not model — "Availability & terms",
/// "Qualification, documents & languages", or a future zone this build has
/// never heard of. Rendered as its own v3 card so no server line is lost.
class ResumeExtraSection {
  const ResumeExtraSection({
    required this.id,
    required this.title,
    this.chipGroups = const <ResumeValueGroup>[],
    this.tickGroups = const <ResumeValueGroup>[],
    this.facts = const <ResumeFact>[],
  });

  final String id;
  final String title;
  final List<ResumeValueGroup> chipGroups;
  final List<ResumeValueGroup> tickGroups;
  final List<ResumeFact> facts;

  bool get isEmpty => chipGroups.isEmpty && tickGroups.isEmpty && facts.isEmpty;
}

/// The v3 card slots for one resume.
class ResumeSlots {
  const ResumeSlots({
    this.capabilityTitle,
    this.machines = const <String>[],
    this.machinesLabel,
    this.controllers = const <String>[],
    this.controllersLabel,
    this.materials = const <String>[],
    this.materialsTitle,
    this.operations = const <String>[],
    this.operationsTitle,
    this.workholding = const <String>[],
    this.instrumentGroups = const <ResumeValueGroup>[],
    this.drawingReading,
    this.otherGroups = const <ResumeValueGroup>[],
    this.otherFacts = const <ResumeFact>[],
    this.extraSections = const <ResumeExtraSection>[],
    this.salary,
  });

  /// The server's own title for the capability zone ("Machines, controllers &
  /// capability", "Processes, positions & capability", …). Null → the card
  /// falls back to a neutral title.
  final String? capabilityTitle;

  final List<String> machines;

  /// The machine row's own label, when the card needs to name the group.
  final String? machinesLabel;

  final List<String> controllers;
  final String? controllersLabel;

  final List<String> materials;

  /// The materials card's title — the server's row label ("Materials", "Tool
  /// steels", …), never the spec's turner-only "Alloys".
  final String? materialsTitle;

  final List<String> operations;
  final String? operationsTitle;

  final List<String> workholding;

  /// Measuring / inspection / quality rows, kept as separate labelled groups
  /// because a sheet can carry more than one.
  final List<ResumeValueGroup> instrumentGroups;

  /// The drawing-reading value ("Reads 2D drawings and GD&T"). Null hides the
  /// callout entirely — the spec's panel is never shown empty.
  final String? drawingReading;

  /// Every OTHER capability row (setting, troubleshooting, unknown keys),
  /// under its own label.
  final List<ResumeValueGroup> otherGroups;

  /// Every other capability FACT row (tolerance, sector, programming level).
  final List<ResumeFact> otherFacts;

  /// Non-capability zones, in the server's order.
  final List<ResumeExtraSection> extraSections;

  /// The already-formatted expected salary ("₹24,000 – ₹28,000 / month").
  /// Null hides the salary box.
  final String? salary;

  /// Spec card 2 — hidden when the worker has neither machines nor
  /// controllers.
  bool get hasCapabilityCard => machines.isNotEmpty || controllers.isNotEmpty;

  /// Spec card 3.
  bool get hasMaterialsCard => materials.isNotEmpty;

  /// Spec card 4 — hidden only when every one of its sub-blocks is empty.
  bool get hasOperationsCard =>
      operations.isNotEmpty ||
      workholding.isNotEmpty ||
      instrumentGroups.isNotEmpty ||
      drawingReading != null ||
      otherGroups.isNotEmpty ||
      otherFacts.isNotEmpty;

  /// The real count for the capability card's pill: machines + controllers.
  /// Digits only (ruling R8) — there is no verification signal to justify the
  /// spec's "7 Verified".
  int get capabilityCount => machines.length + controllers.length;
}

/// Maps a `format: "trade_sheet"` document onto the v3 slots.
ResumeSlots mapTradeSheet(TradeSheetResumeDocument document) {
  String? capabilityTitle;
  final List<String> machines = <String>[];
  String? machinesLabel;
  final List<String> controllers = <String>[];
  String? controllersLabel;
  final List<String> materials = <String>[];
  String? materialsTitle;
  final List<String> operations = <String>[];
  String? operationsTitle;
  final List<String> workholding = <String>[];
  final List<ResumeValueGroup> instrumentGroups = <ResumeValueGroup>[];
  String? drawingReading;
  final List<ResumeValueGroup> otherGroups = <ResumeValueGroup>[];
  final List<ResumeFact> otherFacts = <ResumeFact>[];
  final List<ResumeExtraSection> extraSections = <ResumeExtraSection>[];
  String? salary;

  for (final ResumeDocumentSectionDto section in document.sections) {
    if (!section.hasRows) continue; // an empty zone shows no heading

    if (section.id == kCapabilitySectionId) {
      capabilityTitle = _clean(section.title);
      // chipRows and tickRows are both "a label with several values"; the
      // sheet's choice between pills and ticks only decides how a row the v3
      // cards do NOT model is drawn.
      for (final ResumeListRowDto row in section.chipRows) {
        _sortListRow(
          row: row,
          tick: false,
          machines: machines,
          controllers: controllers,
          materials: materials,
          operations: operations,
          workholding: workholding,
          instrumentGroups: instrumentGroups,
          otherGroups: otherGroups,
          onMachinesLabel: (String l) => machinesLabel ??= l,
          onControllersLabel: (String l) => controllersLabel ??= l,
          onMaterialsTitle: (String l) => materialsTitle ??= l,
          onOperationsTitle: (String l) => operationsTitle ??= l,
        );
      }
      for (final ResumeListRowDto row in section.tickRows) {
        _sortListRow(
          row: row,
          tick: true,
          machines: machines,
          controllers: controllers,
          materials: materials,
          operations: operations,
          workholding: workholding,
          instrumentGroups: instrumentGroups,
          otherGroups: otherGroups,
          onMachinesLabel: (String l) => machinesLabel ??= l,
          onControllersLabel: (String l) => controllersLabel ??= l,
          onMaterialsTitle: (String l) => materialsTitle ??= l,
          onOperationsTitle: (String l) => operationsTitle ??= l,
        );
      }
      for (final ResumeFactRowDto row in section.factRows) {
        if (row.value.isEmpty) continue;
        if (row.key == kDrawingReadingRowKey) {
          drawingReading = _clean(row.value);
          continue;
        }
        if (salary == null && _isSalaryLabel(row.label)) {
          salary = _clean(row.value);
          continue;
        }
        otherFacts.add(_fact(row));
      }
      continue;
    }

    // Any other zone keeps its server title and all three row styles. The
    // salary fact is LIFTED OUT when the profile card's salary box takes it,
    // so the same number is not printed twice on one screen.
    final List<ResumeValueGroup> chipGroups = <ResumeValueGroup>[];
    final List<ResumeValueGroup> tickGroups = <ResumeValueGroup>[];
    final List<ResumeFact> facts = <ResumeFact>[];
    for (final ResumeListRowDto row in section.chipRows) {
      final ResumeValueGroup? group = _group(row, tick: false);
      if (group != null) chipGroups.add(group);
    }
    for (final ResumeListRowDto row in section.tickRows) {
      final ResumeValueGroup? group = _group(row, tick: true);
      if (group != null) tickGroups.add(group);
    }
    for (final ResumeFactRowDto row in section.factRows) {
      if (row.value.isEmpty) continue;
      if (salary == null && _isSalaryLabel(row.label)) {
        salary = _clean(row.value);
        continue;
      }
      facts.add(_fact(row));
    }
    final ResumeExtraSection extra = ResumeExtraSection(
      id: section.id,
      title: _clean(section.title),
      chipGroups: chipGroups,
      tickGroups: tickGroups,
      facts: facts,
    );
    if (!extra.isEmpty) extraSections.add(extra);
  }

  return ResumeSlots(
    capabilityTitle: capabilityTitle,
    machines: machines,
    machinesLabel: machinesLabel,
    controllers: controllers,
    controllersLabel: controllersLabel,
    materials: materials,
    materialsTitle: materialsTitle,
    operations: operations,
    operationsTitle: operationsTitle,
    workholding: workholding,
    instrumentGroups: instrumentGroups,
    drawingReading: drawingReading,
    otherGroups: otherGroups,
    otherFacts: otherFacts,
    extraSections: extraSections,
    salary: salary,
  );
}

/// Puts one list row into its slot, or keeps it under its own label.
void _sortListRow({
  required ResumeListRowDto row,
  required bool tick,
  required List<String> machines,
  required List<String> controllers,
  required List<String> materials,
  required List<String> operations,
  required List<String> workholding,
  required List<ResumeValueGroup> instrumentGroups,
  required List<ResumeValueGroup> otherGroups,
  required void Function(String) onMachinesLabel,
  required void Function(String) onControllersLabel,
  required void Function(String) onMaterialsTitle,
  required void Function(String) onOperationsTitle,
}) {
  final List<String> values = _cleanAll(row.values);
  if (values.isEmpty) return;
  final String label = _clean(row.label);
  final String? key = row.key;

  if (key != null && kMachineRowKeys.contains(key)) {
    machines.addAll(values);
    onMachinesLabel(label);
    return;
  }
  if (key == kControllerRowKey) {
    controllers.addAll(values);
    onControllersLabel(label);
    return;
  }
  if (key != null && kMaterialRowKeys.contains(key)) {
    materials.addAll(values);
    onMaterialsTitle(label);
    return;
  }
  if (key != null && kOperationRowKeys.contains(key)) {
    operations.addAll(values);
    onOperationsTitle(label);
    return;
  }
  if (key == kWorkholdingRowKey) {
    workholding.addAll(values);
    return;
  }
  if (key != null && kInstrumentRowKeys.contains(key)) {
    instrumentGroups.add(
      ResumeValueGroup(label: label, values: values, tick: tick),
    );
    return;
  }
  // No key, or a key this build has never seen: keep it, under its own label.
  otherGroups.add(ResumeValueGroup(label: label, values: values, tick: tick));
}

ResumeValueGroup? _group(ResumeListRowDto row, {required bool tick}) {
  final List<String> values = _cleanAll(row.values);
  if (values.isEmpty) return null;
  return ResumeValueGroup(label: _clean(row.label), values: values, tick: tick);
}

ResumeFact _fact(ResumeFactRowDto row) =>
    ResumeFact(label: _clean(row.label), value: _factValue(row));

/// The facts the profile card shows above the cards: the trade verdict, the
/// city/availability line under it, and the expected salary.
///
/// One type for all three document shapes, because the card is the same card:
/// a trade sheet has a server-composed two-line masthead, a generic document
/// has flat fields, and a worker with neither has the parsed resume text.
class ResumeProfileFacts {
  const ResumeProfileFacts({this.subtitle, this.secondLine, this.salary});

  /// "CNC Turner · 8 yrs · Fanuc" — the trade verdict. Null hides the line.
  final String? subtitle;

  /// "Faridabad · Available now · expects ₹32,000". Null hides the line.
  ///
  /// The spec's card has no slot for this, but the trade sheet composes it and
  /// it carries the worker's city and availability — dropping it would lose
  /// real data the PDF prints.
  final String? secondLine;

  /// Already formatted and ready to print. Null hides the salary box.
  final String? salary;
}

/// Resolves the profile card's facts for whichever document shape exists.
///
/// [parsed] is the legacy text parse, used when there is no structured
/// document at all (and as the source for a `generic` document's missing
/// pieces) — exactly the fallback the tab already relies on.
ResumeProfileFacts resolveProfileFacts({
  required ResumeDocument? document,
  required ParsedResume parsed,
}) {
  if (document is TradeSheetResumeDocument) {
    // The server already composed both lines with its own ` · ` separators.
    // NEVER re-split them: the joiner is also used inside values.
    return ResumeProfileFacts(
      subtitle: _nullIfEmpty(_clean(document.headline.line1 ?? '')),
      secondLine: _nullIfEmpty(_clean(document.headline.line2 ?? '')),
      salary: _tradeSheetSalary(document),
    );
  }
  if (document is GenericResumeDocument) {
    final List<String> parts = <String>[
      if (_nullIfEmpty(document.headline ?? '') != null)
        _clean(document.headline!),
      if (document.experienceYears != null && document.experienceYears! > 0)
        _experienceLabel(document.experienceYears!),
      ..._cleanAll(document.controllers).take(3),
    ];
    final List<String> secondParts = <String>[
      if (_nullIfEmpty(document.location ?? '') != null)
        _clean(document.location!),
      if (_nullIfEmpty(document.availability ?? '') != null)
        _clean(document.availability!),
    ];
    return ResumeProfileFacts(
      subtitle: parts.isEmpty ? null : parts.join(' · '),
      secondLine: secondParts.isEmpty ? null : secondParts.join(' · '),
      // The generic document is the ONE shape carrying a numeric salary, so
      // it is formatted here with the app's single money formatter rather
      // than a second ₹ format invented for this screen.
      salary: _formatMonthlySalary(document.expectedSalary),
    );
  }
  // No structured document: the deterministic resume text is all there is.
  final List<String> parts = <String>[
    for (final String label in <String>['Role', 'Trade', 'Experience'])
      if (_entry(parsed, label) != null) _entry(parsed, label)!,
  ];
  final String? location = _entry(parsed, 'Current location');
  return ResumeProfileFacts(
    subtitle: parts.isEmpty ? null : parts.join(' · '),
    secondLine: location,
    salary: _formatTextSalary(_entry(parsed, 'Expected salary')),
  );
}

/// The trade sheet's salary comes from a fact row whose value the server has
/// ALREADY formatted ("₹24,000 – ₹28,000 / month"). It is printed verbatim —
/// re-parsing a formatted range to reformat it would only invent ways to be
/// wrong (backend gap B10: there is no numeric field on this shape).
String? _tradeSheetSalary(TradeSheetResumeDocument document) {
  for (final ResumeDocumentSectionDto section in document.sections) {
    for (final ResumeFactRowDto row in section.factRows) {
      if (row.value.isNotEmpty && _isSalaryLabel(row.label)) {
        return _clean(row.value);
      }
    }
  }
  return null;
}

/// Matches the ONE money shape ai-service's deterministic text produces:
/// `Expected salary: 24000 per month` (extraction.py builds it with a bare
/// `:.0f`), or the same line without the period.
final RegExp _kTextSalary = RegExp(
  r'^(\d{3,9})(\s*per\s*month)?$',
  caseSensitive: false,
);

/// The legacy TEXT path's salary, printed the way money is printed everywhere
/// else in the app.
///
/// `24000 per month` is the worker's real number, but a bare five-digit run in
/// the green money box is the hardest form of it to read — the rest of the app
/// writes ₹ and Indian grouping, and this is the one place that did not. ONLY a
/// pure number is reformatted: anything the server already composed
/// ('₹24,000 – ₹28,000 / month', 'Negotiable') is printed verbatim, because
/// re-deriving a formatted value only invents ways to be wrong. The ' / month'
/// suffix is kept only when the text actually said so — a period nobody stated
/// is never added.
String? _formatTextSalary(String? value) {
  if (value == null) return null;
  final RegExpMatch? match = _kTextSalary.firstMatch(value.trim());
  if (match == null) return value;
  final int? rupees = int.tryParse(match.group(1)!);
  if (rupees == null || rupees <= 0) return value;
  final String amount = '₹${formatIndianGrouped(rupees)}';
  return match.group(2) == null ? amount : '$amount / month';
}

/// "₹35,000 / month" from a rupee integer, Indian-grouped.
///
/// A non-positive amount is NOT a salary and returns null, so the box hides
/// rather than printing "₹0 / month".
String? _formatMonthlySalary(int? rupeesPerMonth) {
  if (rupeesPerMonth == null || rupeesPerMonth <= 0) return null;
  return '₹${formatIndianGrouped(rupeesPerMonth)} / month';
}

String _experienceLabel(int years) => years == 1 ? '1 saal' : '$years saal';

bool _isSalaryLabel(String label) =>
    label.trim().toLowerCase() == kSalaryFactLabel.toLowerCase();

/// A parsed entry's value, or null when the text did not carry it.
String? _entry(ParsedResume parsed, String label) {
  for (final ResumeEntry e in parsed.entries) {
    if (e.label.toLowerCase() == label.toLowerCase()) {
      return _nullIfEmpty(e.value);
    }
  }
  return null;
}

/// A fact's value, humanized. Education values are the one field known to
/// carry a raw scalar (`below_10`), so they go through the same humanizer the
/// legacy renderer uses at its own display edge.
String _factValue(ResumeFactRowDto row) {
  final String value = _clean(row.value);
  return row.label.toLowerCase().contains('education')
      ? humanizeEducationLevel(value)
      : value;
}

String _clean(String value) => replaceTaxonomyIds(value).trim();

List<String> _cleanAll(Iterable<String> values) => <String>[
  for (final String v in values)
    if (_clean(v).isNotEmpty) _clean(v),
];

String? _nullIfEmpty(String value) =>
    value.trim().isEmpty ? null : value.trim();
