import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/education_label.dart';

/// One `Label: value` line parsed out of the deterministic resume text.
class ResumeEntry {
  const ResumeEntry(this.label, this.value);
  final String label;
  final String value;
}

/// The resume text, split into a DRAFT flag + its labelled entries.
///
/// The resume body is a deterministic `Label: value` template built server-side
/// (ADR-0013; apps/ai-service/app/extraction.py `build_resume`), so it is safe to
/// re-structure for display WITHOUT re-fetching or fabricating anything — this is
/// a pure presentation transform of the SAME real, per-worker text the tab already
/// showed as one plain block.
class ParsedResume {
  const ParsedResume({required this.isDraft, required this.entries});
  final bool isDraft;
  final List<ResumeEntry> entries;

  bool get isEmpty => entries.isEmpty;
}

/// Parse the deterministic resume body into a [ParsedResume].
///
/// Robust by construction, because the display must never lose a line the server
/// actually produced:
///   * The `WORKER PROFILE [(DRAFT)]` banner line sets [ParsedResume.isDraft] and
///     is not itself an entry.
///   * A line of the form `Label: value` becomes an entry.
///   * An INDENTED continuation line (the template soft-wraps long Skills/Machines
///     values) is appended to the previous entry rather than dropped.
///   * Any other non-empty, non-label line (e.g. a mock-mode footer) is ignored —
///     it carries no `Label:` and belongs to no field.
/// Empty values ("(to be confirmed)" is a value, so it is kept — an honest
/// placeholder the worker should see) are preserved; truly blank ones are skipped.
/// The night-shift readiness pref's resume label (matches the PDF template + the
/// Edit-resume toggle). It is a worker RESUME PREF (workers.resumeNightShiftReady),
/// carried OUTSIDE the deterministic text body, so it is injected here.
const String kNightShiftLabel = 'Night shift ke liye taiyaar';

/// The template's education-level label. Its VALUE is a raw scalar the extractor
/// writes (e.g. `below_10`), so it is humanized at this display edge — a raw
/// token must never reach a low-literacy worker's screen (see the no-raw-ids
/// rule; the same [humanizeEducationLevel] already used by the profile tab).
const String kEducationLevelLabel = 'Education level';

ParsedResume parseResumeText(String text, {bool? nightShiftReady}) {
  bool isDraft = false;
  final List<ResumeEntry> entries = <ResumeEntry>[];

  for (final String raw in text.split('\n')) {
    if (raw.trim().isEmpty) continue;

    // Indented line with an open entry → a soft-wrapped continuation of it.
    if (RegExp(r'^\s').hasMatch(raw) && entries.isNotEmpty) {
      final ResumeEntry last = entries.removeLast();
      entries.add(ResumeEntry(last.label, '${last.value} ${raw.trim()}'.trim()));
      continue;
    }

    final String line = raw.trim();
    if (line.toUpperCase().startsWith('WORKER PROFILE')) {
      isDraft = line.toUpperCase().contains('DRAFT');
      continue;
    }

    final int colon = line.indexOf(':');
    if (colon <= 0) continue; // no label → not a field line
    final String label = line.substring(0, colon).trim();
    final String rawValue = line.substring(colon + 1).trim();
    if (rawValue.isEmpty) continue;
    // The education-level field carries a raw scalar (`below_10`); humanize it
    // here so the tab shows "10th se kam", never the token. Every other field is
    // free text / already-resolved taxonomy and passes through untouched.
    final String value = label.toLowerCase() == kEducationLevelLabel.toLowerCase()
        ? humanizeEducationLevel(rawValue)
        : rawValue;
    entries.add(ResumeEntry(label, value));
  }

  // Night-shift readiness rides outside the text body — surface it as a Yes/No
  // entry (the section spec places it in Location, under Current location). Skip if
  // the text already carried the line.
  // Only augment a resume that actually parsed as the template — a non-template
  // body (e.g. a mock/degraded string) must still fall back to raw text, not be
  // turned into a one-line night-shift section.
  if (nightShiftReady != null &&
      entries.isNotEmpty &&
      !entries.any((ResumeEntry e) =>
          e.label.toLowerCase() == kNightShiftLabel.toLowerCase())) {
    entries.add(ResumeEntry(kNightShiftLabel, nightShiftReady ? 'Yes' : 'No'));
  }

  return ParsedResume(isDraft: isDraft, entries: entries);
}

/// A resume section: an icon + title and the labels that live under it.
class _SectionSpec {
  const _SectionSpec(this.title, this.icon, this.labels,
      {this.hideRowLabels = false});
  final String title;
  final IconData icon;
  final List<String> labels;

  /// When true each row shows only its VALUE — used for a REPEATED-label section
  /// like Work History, where the section title is already the label and
  /// "Work history: …" on every line would be redundant.
  final bool hideRowLabels;
}

/// The sections from the design, in the template's own order, and which resume
/// labels each owns. Labels match `build_resume` exactly (case-insensitive at
/// match time). EVERY label the template can emit is owned by a section here, so
/// nothing falls into the generic "More" bucket:
///  - Work history (`_work_history_lines`, a repeatable `Work history:` label),
///  - Availability + Expected salary (the worker's job preferences).
const List<_SectionSpec> _sections = <_SectionSpec>[
  _SectionSpec('General Info', Icons.work_outline_rounded,
      <String>['Role', 'Trade', 'Experience']),
  _SectionSpec('Technical Skills', Icons.settings_rounded,
      <String>['Machines', 'Skills']),
  // Each job is its own `Work history:` line — show the values only under the
  // section title (repeated labels would read redundantly).
  _SectionSpec('Work History', Icons.work_history_outlined,
      <String>['Work history'], hideRowLabels: true),
  _SectionSpec('Education & Certifications', Icons.school_outlined, <String>[
    'Education level',
    'Field of study',
    'Education',
    'Certifications',
  ]),
  // Night-shift readiness sits under Location, right BELOW the current city.
  _SectionSpec('Location', Icons.location_on_outlined,
      <String>['Current location', kNightShiftLabel, 'Preferred locations']),
  // When the worker can start + their asked pay — their own document, last.
  _SectionSpec('Availability & Salary', Icons.event_available_outlined,
      <String>['Availability', 'Expected salary']),
];

/// Renders a [ParsedResume] as the design's grouped, icon-led sections.
///
/// Every parsed entry is shown: entries whose label is not owned by one of the
/// four known sections fall into a trailing "More" section, so an added field
/// from a future template version is surfaced rather than silently dropped.
class ResumeSectionsView extends StatelessWidget {
  const ResumeSectionsView({super.key, required this.parsed});

  final ParsedResume parsed;

  @override
  Widget build(BuildContext context) {
    // Case-insensitive lookup from label → the entries carrying it (a label can
    // in principle repeat; keep them all).
    final Map<String, List<ResumeEntry>> byLabel = <String, List<ResumeEntry>>{};
    for (final ResumeEntry e in parsed.entries) {
      byLabel.putIfAbsent(e.label.toLowerCase(), () => <ResumeEntry>[]).add(e);
    }

    final Set<String> claimed = <String>{};
    final List<Widget> sections = <Widget>[];

    for (final _SectionSpec spec in _sections) {
      final List<ResumeEntry> rows = <ResumeEntry>[];
      for (final String label in spec.labels) {
        final List<ResumeEntry>? found = byLabel[label.toLowerCase()];
        if (found != null) {
          rows.addAll(found);
          claimed.add(label.toLowerCase());
        }
      }
      if (rows.isEmpty) continue; // never render an empty section
      sections.add(_ResumeSection(
        title: spec.title,
        icon: spec.icon,
        rows: rows,
        hideRowLabels: spec.hideRowLabels,
      ));
    }

    // Anything the template emitted that no known section owns — surface it,
    // never drop it.
    final List<ResumeEntry> leftover = parsed.entries
        .where((ResumeEntry e) => !claimed.contains(e.label.toLowerCase()))
        .toList();
    if (leftover.isNotEmpty) {
      sections.add(_ResumeSection(
        title: 'More',
        icon: Icons.info_outline_rounded,
        rows: leftover,
      ));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int i = 0; i < sections.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(height: AppSpacing.s5),
          sections[i],
        ],
      ],
    );
  }
}

class _ResumeSection extends StatelessWidget {
  const _ResumeSection({
    required this.title,
    required this.icon,
    required this.rows,
    this.hideRowLabels = false,
  });

  final String title;
  final IconData icon;
  final List<ResumeEntry> rows;
  final bool hideRowLabels;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          children: <Widget>[
            Icon(icon, size: 20, color: AppColors.textBrand),
            const SizedBox(width: AppSpacing.s2),
            Text(
              title,
              style: AppTypography.display(
                size: AppTypography.sizeMd,
                weight: FontWeight.w700,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s2),
        Padding(
          // Indent the rows under the icon so the section reads as a group.
          padding: const EdgeInsets.only(left: AppSpacing.s7),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              for (final ResumeEntry e in rows) ...<Widget>[
                _EntryRow(
                    label: e.label, value: e.value, hideLabel: hideRowLabels),
                if (e != rows.last) const SizedBox(height: AppSpacing.s1),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// One `Label: value` line — the label muted, the value in body weight, wrapping
/// naturally for long skill/machine lists. With [hideLabel] it renders the VALUE
/// alone (the section title carries the label), for repeated-label sections.
class _EntryRow extends StatelessWidget {
  const _EntryRow({
    required this.label,
    required this.value,
    this.hideLabel = false,
  });

  final String label;
  final String value;
  final bool hideLabel;

  @override
  Widget build(BuildContext context) {
    if (hideLabel) {
      return Text(
        value,
        style: AppTypography.body(
          size: AppTypography.sizeMd,
          color: AppColors.textPrimary,
        ),
      );
    }
    return RichText(
      text: TextSpan(
        style: AppTypography.body(size: AppTypography.sizeMd),
        children: <InlineSpan>[
          TextSpan(
            text: '$label: ',
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textSecondary,
            ),
          ),
          TextSpan(
            text: value,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}
