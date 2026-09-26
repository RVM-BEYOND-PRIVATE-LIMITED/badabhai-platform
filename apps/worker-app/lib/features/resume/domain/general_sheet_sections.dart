/// #1736 — THE BADABHAI GENERAL SHEET, PROJECTED FOR THE RESUME TAB.
///
/// Every worker OUTSIDE the 21 predefined roles now prints `bb_general` (#1735)
/// instead of the trade sheet, and the tab drew the old cards regardless — so
/// Download, Share and the employer's copy showed one format while the worker's
/// own screen showed another. This is the projection that closes that gap: the
/// SAME document, split into the sheet's own five sections.
///
/// PURE, AND SEPARATE FROM THE WIDGETS, for the same reason `mapTradeSheet` is:
/// the routing is the part that can silently drop a worker's row, so it is
/// unit-testable without pumping a screen.
///
/// WHAT DECIDES A ROW'S SECTION IS ITS LABEL, and that is not a free choice —
/// it is how the printed sheet does it. The server sends the qualification rows
/// as ONE list (Education, Qualification, Certificates, Training, Languages
/// spoken) and `bb_general.v1.html` splits that one list across three sections
/// with `[data-label]` selectors. Matching the same labels here is matching the
/// template, not guessing at meaning.
///
/// THE ROUTING DEFAULTS TO VISIBLE, exactly as the template's does: Education
/// takes the education labels, Availability & Terms takes Languages spoken, and
/// Certifications & Training takes EVERYTHING ELSE — so a label the backend
/// adds or renames later prints under its own name rather than vanishing.
library;

import '../../../core/api/api_models.dart';
import '../../../core/util/taxonomy_labels.dart';

/// One `Label: value` line, as the sheet prints it.
///
/// [value] is already joined for a list row ("Hindi, Marathi"): the sheet's
/// rows are comma lists, not chips, so the join belongs here where it can be
/// tested rather than in the widget.
class GeneralSheetRow {
  const GeneralSheetRow({required this.label, required this.value});

  final String label;
  final String value;
}

/// One line under Certifications & Training.
///
/// [label] is NULL for the two labels the sheet prints as bare bullets
/// (Certificates, Training — the section heading already says what they are)
/// and PRESENT for anything else, so an unrecognised row can never print as an
/// anonymous line.
class GeneralSheetCertLine {
  const GeneralSheetCertLine({required this.value, this.label});

  final String value;
  final String? label;
}

/// The general sheet's sections, in the order the sheet prints them.
class GeneralSheetSections {
  const GeneralSheetSections({
    this.skills = const <GeneralSheetRow>[],
    this.availability = const <GeneralSheetRow>[],
    this.education = const <String>[],
    this.certifications = const <GeneralSheetCertLine>[],
  });

  /// "Core Skills: …", "Machines & Tools: …", "Controllers: …", plus any
  /// capability rows a mapped pack supplies. Empty for a worker whose pack has
  /// no capability rows AND whose document does not yet carry the three lists —
  /// which is every worker today, until the backend field lands.
  final List<GeneralSheetRow> skills;

  /// The terms rows, then Languages spoken, then Documents ready.
  final List<GeneralSheetRow> availability;

  /// The education VALUES only — the section heading is the label, so the sheet
  /// prints the degree line bold and unlabelled.
  final List<String> education;

  final List<GeneralSheetCertLine> certifications;
}

/// The zone id that carries a mapped pack's capability rows.
///
/// Stated here rather than imported from the card mapper: that file is
/// presentation and this projection is domain. The ids are the server's
/// (`toResumeDocument`), and `resume_document_model_test.dart` pins them.
const String kGeneralSheetCapabilityZoneId = 'capability';

/// The zone id that carries the qualification rows the sheet splits three ways.
const String kGeneralSheetQualificationsZoneId = 'qualifications';

/// The terms row the profile card's salary box already prints.
const String kGeneralSheetSalaryLabel = 'Salary expected';

/// The label the general sheet gives the worker's own skills list.
const String kGeneralSheetSkillsLabel = 'Core Skills';

/// The label for the machines/tools list.
const String kGeneralSheetMachinesLabel = 'Machines & Tools';

/// The label for the controllers list.
const String kGeneralSheetControllersLabel = 'Controllers';

/// The qualification labels that belong under Education.
///
/// TWO, NOT ONE: `Qualification` is a real row label the degradation ladder
/// re-inserts server-side, and `bb_general.v1.html` routes it with `Education`
/// (`.sec-edu > .q[data-label="Qualification"]`). Matching only `Education`
/// would drop a worker's protected credential line into the wrong section.
const Set<String> kGeneralSheetEducationLabels = <String>{
  'Education',
  'Qualification',
};

/// The qualification label that moves UP into Availability & Terms.
const String kGeneralSheetLanguagesLabel = 'Languages spoken';

/// The qualification labels Certifications & Training prints as bare bullets.
const Set<String> kGeneralSheetBulletLabels = <String>{
  'Certificates',
  'Training',
};

/// Projects [document] onto the general sheet's sections.
///
/// THE SALARY ROW IS LIFTED OUT, exactly as `mapTradeSheet` lifts it: the
/// profile card above the sheet already prints the expected salary in its own
/// box, and the same number twice on one screen reads as two different facts
/// (the card mapper's `kSalaryFactLabel` rule, on the same label).
GeneralSheetSections mapGeneralSheet(TradeSheetResumeDocument document) {
  final List<GeneralSheetRow> skills = <GeneralSheetRow>[];
  final List<GeneralSheetRow> availability = <GeneralSheetRow>[];
  final List<String> education = <String>[];
  final List<GeneralSheetCertLine> certifications = <GeneralSheetCertLine>[];

  // The worker's own three lists, when the document carries them. Each row is
  // omitted entirely when its list is empty — the sheet's `.lrow:empty` rule.
  void addList(String label, List<String> values) {
    final List<String> clean = _cleanAll(values);
    if (clean.isEmpty) return;
    skills.add(GeneralSheetRow(label: label, value: clean.join(', ')));
  }

  for (final ResumeDocumentSectionDto section in document.sections) {
    if (!section.hasRows) continue; // an empty zone draws nothing at all

    if (section.id == kGeneralSheetCapabilityZoneId) {
      // A mapped pack's capability rows print in Skills, as comma lists — the
      // sheet has no chips and no ticks, so both row styles read the same way.
      for (final ResumeListRowDto row in <ResumeListRowDto>[
        ...section.chipRows,
        ...section.tickRows,
      ]) {
        final GeneralSheetRow? line = _listRow(row);
        if (line != null) skills.add(line);
      }
      for (final ResumeFactRowDto row in section.factRows) {
        final GeneralSheetRow? line = _factRow(row);
        if (line != null) skills.add(line);
      }
      continue;
    }

    if (section.id == kGeneralSheetQualificationsZoneId) {
      for (final ResumeFactRowDto row in section.factRows) {
        final String label = _clean(row.label);
        final String value = _clean(row.value);
        if (value.isEmpty) continue;
        if (kGeneralSheetEducationLabels.contains(label)) {
          education.add(value);
          continue;
        }
        if (label == kGeneralSheetLanguagesLabel) {
          availability.add(GeneralSheetRow(label: label, value: value));
          continue;
        }
        certifications.add(
          GeneralSheetCertLine(
            value: value,
            // Certificates and Training are the sheet's bullets; every other
            // label keeps its name so it is never an anonymous line.
            label: kGeneralSheetBulletLabels.contains(label) ? null : label,
          ),
        );
      }
      // "Documents ready" and any other tick/chip row stay with the terms, as
      // the sheet's Availability & Terms region prints them.
      for (final ResumeListRowDto row in <ResumeListRowDto>[
        ...section.chipRows,
        ...section.tickRows,
      ]) {
        final GeneralSheetRow? line = _listRow(row);
        if (line != null) availability.add(line);
      }
      continue;
    }

    // The terms zone, and any future zone this build has never seen: its rows
    // read as Availability & Terms lines rather than being dropped.
    for (final ResumeFactRowDto row in section.factRows) {
      if (_isSalaryLabel(row.label)) continue; // the profile card's box owns it
      final GeneralSheetRow? line = _factRow(row);
      if (line != null) availability.add(line);
    }
    for (final ResumeListRowDto row in <ResumeListRowDto>[
      ...section.chipRows,
      ...section.tickRows,
    ]) {
      final GeneralSheetRow? line = _listRow(row);
      if (line != null) availability.add(line);
    }
  }

  // AFTER the capability rows, as the template orders them.
  addList(kGeneralSheetSkillsLabel, document.skills);
  addList(kGeneralSheetMachinesLabel, document.machines);
  addList(kGeneralSheetControllersLabel, document.controllers);

  return GeneralSheetSections(
    skills: skills,
    availability: availability,
    education: education,
    certifications: certifications,
  );
}

GeneralSheetRow? _listRow(ResumeListRowDto row) {
  final List<String> values = _cleanAll(row.values);
  final String label = _clean(row.label);
  if (values.isEmpty || label.isEmpty) return null;
  return GeneralSheetRow(label: label, value: values.join(', '));
}

GeneralSheetRow? _factRow(ResumeFactRowDto row) {
  final String label = _clean(row.label);
  final String value = _clean(row.value);
  if (value.isEmpty || label.isEmpty) return null;
  return GeneralSheetRow(label: label, value: value);
}

/// Raw taxonomy ids never reach a worker's screen (the no-raw-ids rule), so
/// every string on its way into a row goes through the same humaniser the card
/// mapper uses.
String _clean(String raw) => replaceTaxonomyIds(raw).trim();

List<String> _cleanAll(List<String> raw) => raw
    .map(_clean)
    .where((String v) => v.isNotEmpty)
    .toList(growable: false);

bool _isSalaryLabel(String label) =>
    label.trim().toLowerCase() == kGeneralSheetSalaryLabel.toLowerCase();
