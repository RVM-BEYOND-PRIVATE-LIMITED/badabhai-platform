import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_reason.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../cubit/resume_cubit.dart';

/// #1343 — renders a `format: "trade_sheet"` [TradeSheetResumeDocument] as the
/// zoned rows the printed sheet uses, so a turner's resume tab reads as the
/// SAME document as their PDF instead of a Dart re-guess of `resume_text`
/// (which cannot represent this layout at all — it is rows, not `Label: value`
/// lines).
///
/// `format: "generic"` and `document == null` are DELIBERATELY NOT handled
/// here — see the call site in `resume_preview_screen.dart`, which still
/// renders those two through the existing (unchanged) `resume_text` parsing
/// path. That path already reads correctly for a non-CNC worker (the
/// acceptance bar in #1343), and [GenericResumeDocument]'s fields are the same
/// facts that text-parser already surfaces, so there is nothing here for it to
/// fix. Only the trade sheet is a layout the OLD renderer structurally cannot
/// draw.
class ResumeDocumentView extends StatelessWidget {
  const ResumeDocumentView({super.key, required this.document});

  final TradeSheetResumeDocument document;

  @override
  Widget build(BuildContext context) {
    final List<Widget> children = <Widget>[];

    final Widget? headline = _headlineBlock(document.headline);
    if (headline != null) {
      children.add(headline);
      children.add(const SizedBox(height: AppSpacing.s5));
    }

    final List<Widget> sectionWidgets = <Widget>[
      for (final ResumeDocumentSectionDto section in document.sections)
        if (section.hasRows) _SheetSection(section: section),
    ];
    final Widget? employmentsBlock = _employmentsSection(document);

    final List<Widget> body = <Widget>[
      ...sectionWidgets,
      if (employmentsBlock != null) employmentsBlock,
    ];

    for (int i = 0; i < body.length; i++) {
      if (i > 0) children.add(const SizedBox(height: AppSpacing.s5));
      children.add(body[i]);
    }

    if (document.footerMeta != null && document.footerMeta!.isNotEmpty) {
      children.add(const SizedBox(height: AppSpacing.s4));
      children.add(
        Text(
          document.footerMeta!,
          style: AppTypography.body(
            size: AppTypography.size2xs,
            color: AppColors.textMuted,
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  /// The sheet's own two-line masthead verdict ("CNC Turner · 8 yrs · Fanuc" /
  /// "Faridabad · Available now · expects ₹32,000"). Null when the server sent
  /// neither line — an empty masthead is simply omitted, not shown blank.
  Widget? _headlineBlock(ResumeSheetHeadlineDto headline) {
    final String? line1 =
        (headline.line1 != null && headline.line1!.isNotEmpty) ? headline.line1 : null;
    final String? line2 =
        (headline.line2 != null && headline.line2!.isNotEmpty) ? headline.line2 : null;
    if (line1 == null && line2 == null) return null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (line1 != null)
          Text(
            line1,
            style: AppTypography.display(
              size: AppTypography.sizeMd,
              weight: FontWeight.w700,
            ),
          ),
        if (line2 != null) ...<Widget>[
          const SizedBox(height: AppSpacing.s1),
          Text(
            line2,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ],
    );
  }

  /// The sheet's work-history block — its own zone, matching the OLD "Work
  /// History" section's icon so the tab reads consistently regardless of which
  /// renderer drew it. Null (no heading, nothing shown) when the worker has no
  /// employments — mirrors [ResumeDocumentSectionDto.hasRows]'s own rule for an
  /// empty zone.
  Widget? _employmentsSection(TradeSheetResumeDocument doc) {
    if (doc.employments.isEmpty) return null;
    return _SheetSectionShell(
      title: 'Work History',
      icon: Icons.work_history_outlined,
      children: <Widget>[
        for (final ResumeEmploymentDto e in doc.employments) ...<Widget>[
          _EmploymentEntry(employment: e),
          if (e != doc.employments.last) const SizedBox(height: AppSpacing.s3),
        ],
        if (doc.employmentsMore != null && doc.employmentsMore!.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          Text(
            doc.employmentsMore!,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ],
    );
  }
}

/// Icon per known section id — matches the OLD text-parsed section icons so
/// the tab reads consistently whichever renderer drew it. An id this build
/// does not recognise (a future zone) still renders — just with the generic
/// "info" icon, never a blank/crashing tile.
IconData _sectionIcon(String id) => switch (id) {
      'capability' => Icons.settings_rounded,
      'terms' => Icons.event_available_outlined,
      'qualifications' => Icons.school_outlined,
      _ => Icons.info_outline_rounded,
    };

/// One zoned section (`chipRows` → pills, `tickRows` → ✓ items, `factRows` →
/// label + value), in that order — matching the printed sheet.
class _SheetSection extends StatelessWidget {
  const _SheetSection({required this.section});

  final ResumeDocumentSectionDto section;

  @override
  Widget build(BuildContext context) {
    return _SheetSectionShell(
      title: section.title,
      icon: _sectionIcon(section.id),
      children: <Widget>[
        for (final ResumeListRowDto row in section.chipRows) _ChipRow(row: row),
        for (final ResumeListRowDto row in section.tickRows) _TickRow(row: row),
        for (final ResumeFactRowDto row in section.factRows) _FactRow(row: row),
      ],
    );
  }
}

/// The shared section chrome — icon + title, then its rows indented under it.
/// Matches `_ResumeSection` in `resume_sections.dart` (the text-parsed
/// renderer) so a trade-sheet section and a generic section look like the same
/// design, not two different screens bolted together.
class _SheetSectionShell extends StatelessWidget {
  const _SheetSectionShell({
    required this.title,
    required this.icon,
    required this.children,
  });

  final String title;
  final IconData icon;
  final List<Widget> children;

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
          padding: const EdgeInsets.only(left: AppSpacing.s7),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              for (int i = 0; i < children.length; i++) ...<Widget>[
                if (i > 0) const SizedBox(height: AppSpacing.s3),
                children[i],
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// A `chipRows` entry — the row's label, then its values as pills. Reuses
/// [BbChip] (unselected, non-interactive: `onTap` is null) rather than a
/// bespoke pill, so a resume chip is visually identical to every other chip in
/// the app instead of a fork of the Design System.
class _ChipRow extends StatelessWidget {
  const _ChipRow({required this.row});

  final ResumeListRowDto row;

  @override
  Widget build(BuildContext context) {
    if (row.values.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _RowLabel(row.label),
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            for (final String value in row.values) BbChip(label: value),
          ],
        ),
      ],
    );
  }
}

/// A `tickRows` entry — the row's label, then its values as ✓ items (one per
/// line), matching the printed sheet's tick-list zones (e.g. "Setting").
class _TickRow extends StatelessWidget {
  const _TickRow({required this.row});

  final ResumeListRowDto row;

  @override
  Widget build(BuildContext context) {
    if (row.values.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _RowLabel(row.label),
        const SizedBox(height: AppSpacing.s1),
        for (final String value in row.values)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.s1),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Icon(Icons.check_circle_rounded,
                    size: 18, color: AppColors.green500),
                const SizedBox(width: AppSpacing.s2),
                Expanded(
                  child: Text(
                    value,
                    style: AppTypography.body(
                      size: AppTypography.sizeMd,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// A `factRows` entry — one label + one value, same `Label: value` reading as
/// the text-parsed renderer's `_EntryRow`.
class _FactRow extends StatelessWidget {
  const _FactRow({required this.row});

  final ResumeFactRowDto row;

  @override
  Widget build(BuildContext context) {
    if (row.value.isEmpty) return const SizedBox.shrink();
    return RichText(
      text: TextSpan(
        style: AppTypography.body(size: AppTypography.sizeMd),
        children: <InlineSpan>[
          TextSpan(
            text: '${row.label}: ',
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textSecondary,
            ),
          ),
          TextSpan(
            text: row.value,
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

/// A row's own label, muted and small — sits above its chips/ticks (a
/// `factRow` inlines its label instead; see [_FactRow]).
class _RowLabel extends StatelessWidget {
  const _RowLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: AppTypography.body(
        size: AppTypography.sizeXs,
        weight: FontWeight.w700,
        color: AppColors.textSecondary,
      ),
    );
  }
}

/// One employer on the work-history block — employer (+ role/location inline
/// suffixes, already separator-prefixed server-side), its span, the work
/// description, then any promotion stints.
///
/// #1353/#1354 — STATEFUL only for the own-words reveal/choice affordance
/// below the work line (see [_OwnWordsChoice]); everything else is the
/// unchanged #1343 render.
class _EmploymentEntry extends StatefulWidget {
  const _EmploymentEntry({required this.employment});

  final ResumeEmploymentDto employment;

  @override
  State<_EmploymentEntry> createState() => _EmploymentEntryState();
}

class _EmploymentEntryState extends State<_EmploymentEntry> {
  bool _revealed = false;
  bool _pending = false;

  /// Set the moment THIS screen visit calls `ownWords: true` for this entry.
  ///
  /// The wire's [ResumeEmploymentDto.hasOwnWordsToReveal] cannot tell "never
  /// rewritten" apart from "the worker already declined the rewrite" — both
  /// leave `work == workOwnWords`, by design (see that getter's own doc). So
  /// once the worker keeps their own words, the wire alone can no longer offer
  /// a way back to the polished version. This remembers the worker's OWN
  /// action, in memory, for the rest of this screen visit only — never
  /// persisted, never guessed from server state — so "switch back" (the flow
  /// spec's reversibility requirement) stays reachable the same way it was
  /// offered.
  bool _justKeptOwnWords = false;

  Future<void> _choose(bool ownWords) async {
    final String? id = widget.employment.id;
    if (id == null || _pending) return;
    setState(() => _pending = true);
    try {
      await context
          .read<ResumeCubit>()
          .setEmploymentDescriptionSource(id, ownWords: ownWords);
      if (!mounted) return;
      setState(() {
        _justKeptOwnWords = ownWords;
        // Nothing left to compare once the printed line already is the
        // worker's own words.
        if (ownWords) _revealed = false;
      });
    } on Failure catch (f) {
      // #1353 — the worker tapped a deliberate choice about a sentence
      // carrying their name; a failed write must surface honestly, never
      // look like it silently worked (mirrors ResumeCubit's own doc).
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(failureReason(f).reason)));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ResumeEmploymentDto employment = widget.employment;
    final String heading =
        '${employment.employer}${employment.roleInline ?? ''}${employment.locationSuffix ?? ''}';
    // A genuine rewrite to compare, with an id to act on. See the DTO's own
    // doc — an entry that was never rewritten and one whose rewrite was
    // already declined are indistinguishable here, by design, and both
    // correctly show nothing (below).
    final bool canOfferOwnWords =
        employment.id != null && employment.hasOwnWordsToReveal;
    final bool canOfferPolishedBack =
        !canOfferOwnWords && employment.id != null && _justKeptOwnWords;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (heading.isNotEmpty)
          Text(
            heading,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              weight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
        if (employment.when.isNotEmpty)
          Text(
            employment.when,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
        if (employment.work.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s1),
          Text(
            employment.work,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textPrimary,
            ),
          ),
        ],
        // #1353/#1354 — an entry with nothing to compare shows NOTHING extra:
        // no affordance, no disabled/greyed placeholder.
        if (canOfferOwnWords) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          _OwnWordsChoice(
            revealed: _revealed,
            pending: _pending,
            ownWordsText: employment.workOwnWords!,
            onToggle: () => setState(() => _revealed = !_revealed),
            onKeep: () => _choose(true),
          ),
        ] else if (canOfferPolishedBack) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          BbButton(
            label: 'Polish kiya version rakhein',
            onPressed: () => _choose(false),
            variant: BbButtonVariant.tonal,
            size: BbButtonSize.md,
            loading: _pending,
          ),
        ],
        for (final ResumeEmploymentRoleStintDto stint in employment.roles)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.s1),
            child: Text(
              '${stint.role} · ${stint.when}',
              style: AppTypography.body(
                size: AppTypography.sizeXs,
                color: AppColors.textSecondary,
              ),
            ),
          ),
      ],
    );
  }
}

/// #1353/#1354 — the reveal-then-choose affordance for ONE employment whose
/// printed line was rewritten: a quiet link that reveals [ownWordsText]
/// (the worker's own words, unrewritten), then an EQUALLY-WEIGHTED button to
/// keep them over the polish. Deliberately never [BbButtonVariant.danger] (or
/// any warning styling) — keeping one's own words is a first-class choice,
/// not a downgrade, and needs no "are you sure".
class _OwnWordsChoice extends StatelessWidget {
  const _OwnWordsChoice({
    required this.revealed,
    required this.pending,
    required this.ownWordsText,
    required this.onToggle,
    required this.onKeep,
  });

  final bool revealed;
  final bool pending;
  final String ownWordsText;
  final VoidCallback onToggle;
  final VoidCallback onKeep;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _RevealLink(
          label: revealed
              ? 'Likha hua version chhupayein'
              : 'Aapke apne shabdon mein dekhein',
          icon: revealed ? Icons.expand_less_rounded : Icons.expand_more_rounded,
          onTap: onToggle,
        ),
        if (revealed) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          Container(
            padding: const EdgeInsets.all(AppSpacing.s3),
            decoration: BoxDecoration(
              color: AppColors.canvas,
              borderRadius: BorderRadius.circular(AppRadii.sm),
              border: Border.all(color: AppColors.borderSubtle),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                _RowLabel('Aapke shabdon mein'),
                const SizedBox(height: AppSpacing.s1),
                Text(
                  ownWordsText,
                  style: AppTypography.body(
                    size: AppTypography.sizeMd,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: AppSpacing.s3),
                BbButton(
                  label: 'Apne shabd rakhein',
                  onPressed: onKeep,
                  variant: BbButtonVariant.tonal,
                  size: BbButtonSize.md,
                  loading: pending,
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

/// A quiet, tappable text link (icon + label) — used only for the LOCAL
/// reveal/collapse toggle, which never touches the network (the choice
/// itself is a [BbButton], see [_OwnWordsChoice]). Padded to the worker
/// tap-target floor rather than sized to its text.
class _RevealLink extends StatelessWidget {
  const _RevealLink({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        child: Container(
          constraints: const BoxConstraints(minHeight: AppSpacing.s9),
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, size: 18, color: AppColors.textBrand),
              const SizedBox(width: AppSpacing.s1),
              Text(
                label,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                  color: AppColors.textBrand,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
