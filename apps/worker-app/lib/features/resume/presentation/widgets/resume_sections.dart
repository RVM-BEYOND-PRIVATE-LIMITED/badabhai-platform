import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/education_label.dart';
import '../../../../core/widgets/kit/kit_card.dart';
import '../../../../core/widgets/kit/kit_check_row.dart';
import '../../../../core/widgets/kit/kit_info_chip.dart';
import '../../../../core/widgets/kit/kit_micro_label.dart';
import 'resume_card_slots.dart' show valuesReadAsChips;
import 'resume_document_view.dart' show ResumeWhenPill;

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

  /// Whether the text carried the `WORKER PROFILE (DRAFT)` marker.
  ///
  /// NO LONGER DRIVES THE DRAFT PILL. ai-service stamps that marker on every
  /// resume it builds (backend gap B11), so it was permanently true and told
  /// a confirmed worker their profile was a draft forever. The pill now reads
  /// `profile_status` from the profile summary (ruling R7). Kept because the
  /// flag describes the TEXT honestly and the parser's contract is to lose
  /// nothing.
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
      entries.add(
        ResumeEntry(last.label, '${last.value} ${raw.trim()}'.trim()),
      );
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
    final String value =
        label.toLowerCase() == kEducationLevelLabel.toLowerCase()
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
      !entries.any(
        (ResumeEntry e) =>
            e.label.toLowerCase() == kNightShiftLabel.toLowerCase(),
      )) {
    entries.add(ResumeEntry(kNightShiftLabel, nightShiftReady ? 'Yes' : 'No'));
  }

  return ParsedResume(isDraft: isDraft, entries: entries);
}

/// A resume section: an icon + title and the labels that live under it.
class _SectionSpec {
  const _SectionSpec(
    this.title,
    this.icon,
    this.labels, {
    this.hideRowLabels = false,
  });
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
  _SectionSpec('General Info', Icons.work_outline_rounded, <String>[
    'Role',
    'Trade',
    'Experience',
  ]),
  _SectionSpec('Technical Skills', Icons.settings_suggest_rounded, <String>[
    'Machines',
    'Skills',
  ]),
  // Each job is its own `Work history:` line — show the values only under the
  // section title (repeated labels would read redundantly).
  _SectionSpec('Work History', Icons.work_history_outlined, <String>[
    'Work history',
  ], hideRowLabels: true),
  _SectionSpec('Education & Certifications', Icons.school_outlined, <String>[
    'Education level',
    'Field of study',
    'Education',
    'Certifications',
  ]),
  _SectionSpec('Location', Icons.location_on_outlined, <String>[
    'Current location',
    'Preferred locations',
  ]),
  // When the worker can start, whether they work nights, and their asked pay —
  // their own document, last. OWNER ASK (2026-10-21): night-shift readiness is
  // a WORK TERM, so it sits here; under Location it read as a place (and was a
  // Location card's only line when no city was stated).
  _SectionSpec(
    'Availability, Terms & Salary',
    Icons.event_available_outlined,
    <String>['Availability', kNightShiftLabel, 'Expected salary'],
  ),
];

/// Renders a [ParsedResume] as the v3 card stack (spec §4 chrome), one card per
/// section.
///
/// THE LEGACY PATH, DELIBERATELY KEPT. `document == null` and
/// `format: "generic"` both render through here (#1343's acceptance bar: a
/// non-CNC worker's tab must read exactly as it did before), so the section
/// titles, their label ownership and the trailing "More" bucket are unchanged —
/// only the paint moved to v3. The trade sheet, which has real zoned rows, goes
/// through `ResumeDocumentView` instead.
///
/// Every parsed entry is shown: entries whose label is not owned by one of the
/// known sections fall into a trailing "More" section, so an added field from a
/// future template version is surfaced rather than silently dropped.
class ResumeSectionsView extends StatelessWidget {
  const ResumeSectionsView({super.key, required this.parsed});

  final ParsedResume parsed;

  @override
  Widget build(BuildContext context) {
    // Case-insensitive lookup from label → the entries carrying it (a label can
    // in principle repeat; keep them all).
    final Map<String, List<ResumeEntry>> byLabel =
        <String, List<ResumeEntry>>{};
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
      sections.add(
        _ResumeSection(
          title: spec.title,
          icon: spec.icon,
          rows: rows,
          hideRowLabels: spec.hideRowLabels,
        ),
      );
    }

    // Anything the template emitted that no known section owns — surface it,
    // never drop it.
    final List<ResumeEntry> leftover = parsed.entries
        .where((ResumeEntry e) => !claimed.contains(e.label.toLowerCase()))
        .toList();
    if (leftover.isNotEmpty) {
      sections.add(
        _ResumeSection(
          title: 'More',
          icon: Icons.info_outline_rounded,
          rows: leftover,
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int i = 0; i < sections.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(height: 12),
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
    // OWNER ASK (2026-10-21) — the card reads as a layout, not a paragraph:
    // a job is a block, a list label owns a chip grid, a single fact is a
    // label-over-value tile. Thin dividers separate the pieces.
    final List<Widget> pieces = hideRowLabels
        ? <Widget>[for (final ResumeEntry r in rows) _JobBlock(line: r.value)]
        : <Widget>[for (final ResumeEntry r in rows) _EntryRow(entry: r)];
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          KitCardHeader(icon: icon, title: title),
          const SizedBox(height: 14),
          for (int i = 0; i < pieces.length; i++) ...<Widget>[
            if (i > 0)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Divider(
                  height: 1,
                  thickness: 1,
                  color: OnboardingColors.borderDefault,
                ),
              ),
            pieces[i],
          ],
        ],
      ),
    );
  }
}

/// The labels whose value `build_resume` writes as a LIST joined with ", "
/// (`apps/ai-service/app/extraction.py`: `", ".join(machines)`,
/// `", ".join(skills)`, `", ".join(profile.education)`,
/// `", ".join(profile.certifications)`). Only these are drawn as chips.
///
/// "Preferred locations" is deliberately NOT here: a place can itself carry a
/// comma ("Gurugram, Haryana"), and splitting it would show the worker a city
/// they never named.
const Set<String> _kListLabels = <String>{
  'skills',
  'machines',
  'education',
  'certifications',
};

/// Splits a server-joined list back into its items: on ", " OUTSIDE brackets,
/// so a single item such as "Welding (MIG, TIG)" stays ONE item. Lossless —
/// every character of [value] lands in exactly one item.
List<String> splitResumeList(String value) {
  final List<String> out = <String>[];
  final StringBuffer cur = StringBuffer();
  int depth = 0;
  for (int i = 0; i < value.length; i++) {
    final String ch = value[i];
    if (ch == '(' || ch == '[') depth++;
    if ((ch == ')' || ch == ']') && depth > 0) depth--;
    if (depth == 0 &&
        ch == ',' &&
        i + 1 < value.length &&
        value[i + 1] == ' ') {
      if (cur.toString().trim().isNotEmpty) out.add(cur.toString().trim());
      cur.clear();
      i++; // skip the space after the comma
      continue;
    }
    cur.write(ch);
  }
  if (cur.toString().trim().isNotEmpty) out.add(cur.toString().trim());
  return out;
}

/// One `Label: value` entry, laid out for reading:
///  * a LIST label ([_kListLabels]) — its label as a small caption, its items
///    as a wrapping chip grid (full-width rows when an item is too long to
///    read as a chip, the trade sheet's own rule [valuesReadAsChips]);
///  * any other fact — the label as a small caption, the value under it in a
///    larger, bold line.
class _EntryRow extends StatelessWidget {
  const _EntryRow({required this.entry});

  final ResumeEntry entry;

  @override
  Widget build(BuildContext context) {
    final bool isList = _kListLabels.contains(entry.label.toLowerCase());
    final List<String> items = isList
        ? splitResumeList(entry.value)
        : const <String>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        KitMicroLabel(entry.label),
        const SizedBox(height: 8),
        if (isList && items.isNotEmpty)
          valuesReadAsChips(items)
              ? Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    for (final String v in items) KitInfoChip(label: v),
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    for (int i = 0; i < items.length; i++) ...<Widget>[
                      if (i > 0) const SizedBox(height: 6),
                      KitCheckRow(label: items[i]),
                    ],
                  ],
                )
        else
          Text(
            entry.value,
            style: OnboardingTypography.inter(
              size: 15,
              weight: FontWeight.w600,
              height: 1.35,
            ),
          ),
      ],
    );
  }
}

/// One job from a `Work history:` line, which `build_resume` writes as
/// `role — duration — work done` (`_work_history_lines`: " — ".join(parts),
/// the duration and the work each present only when recorded).
///
/// Drawn as a block: the ROLE as a bold title, the DURATION as a small pill
/// beside it, and the WORK DONE as readable body text under them. Lossless:
/// when the middle part does not read as a duration (no digit, or long), it
/// is kept as work text, never dropped or relabelled.
class _JobBlock extends StatelessWidget {
  const _JobBlock({required this.line});

  final String line;

  @override
  Widget build(BuildContext context) {
    final List<String> parts = line.split(' — ');
    final String role = parts.first.trim();
    String? duration;
    List<String> rest = parts.skip(1).toList();
    if (rest.isNotEmpty &&
        RegExp(r'\d').hasMatch(rest.first) &&
        rest.first.trim().length <= 24) {
      duration = rest.first.trim();
      rest = rest.skip(1).toList();
    }
    final String work = rest.join(' — ').trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Wrap(
          spacing: 8,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: <Widget>[
            Text(
              role,
              style: OnboardingTypography.inter(
                size: 16,
                weight: FontWeight.w700,
                color: OnboardingColors.shiftBlue,
              ),
            ),
            if (duration != null) ResumeWhenPill(text: duration),
          ],
        ),
        if (work.isNotEmpty) ...<Widget>[
          const SizedBox(height: 8),
          Text(
            work,
            style: OnboardingTypography.inter(
              size: 14,
              height: 1.5,
              color: OnboardingColors.ink600,
            ),
          ),
        ],
      ],
    );
  }
}
