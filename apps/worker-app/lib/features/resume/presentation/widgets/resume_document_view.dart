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
    final Widget? trainingBlock = _trainingSection(document);

    final List<Widget> body = <Widget>[
      ...sectionWidgets,
      if (employmentsBlock != null) employmentsBlock,
      // A fresher has training INSTEAD of a work history, never both, so this
      // sits where the history would have been rather than after it.
      if (trainingBlock != null) trainingBlock,
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

  /// The fresher's TRAINING block — the zone he has instead of a work history
  /// (#1476).
  ///
  /// The sheet did not carry this at all before: `experiences` was a field of
  /// the generic document only, so a fresher's `iti_project_work` sentence
  /// printed on the PDF an employer reads while his own resume tab showed
  /// nothing of it. He is the only person who can say whether a sentence about
  /// his own training is true, and he is the worker with the least else on his
  /// page — so he could neither see it nor question it.
  ///
  /// Null (no heading, nothing shown) when there is no training block, which
  /// is every worker who has employments.
  Widget? _trainingSection(TradeSheetResumeDocument doc) {
    if (doc.experiences.isEmpty) return null;
    return _SheetSectionShell(
      title: 'Training',
      icon: Icons.school_outlined,
      // One child per visual row, no spacers — the shell owns spacing (#1475).
      children: <Widget>[
        for (final ResumeExperienceLineDto line in doc.experiences)
          _TrainingEntry(line: line),
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
      // ONE CHILD PER VISUAL ROW, and no spacers of our own (#1475). The shell
      // already puts [AppSpacing.s3] between every pair of children — so a
      // spacer handed in AS a child got padded on BOTH sides, and two
      // employments ended up three gaps apart instead of one. Spacing belongs
      // to the shell; a caller that also supplies it is double-counting.
      children: <Widget>[
        for (final ResumeEmploymentDto e in doc.employments)
          _EmploymentEntry(employment: e),
        if (doc.employmentsMore != null && doc.employmentsMore!.isNotEmpty)
          Text(
            doc.employmentsMore!,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
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
              // The shell owns ALL inter-row spacing (#1475). Callers hand it
              // one child per visual row and never a spacer — a spacer passed
              // in as a child is treated as a row here and padded on both
              // sides, which is what tripled the gap on the work-history zone.
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
/// One training block on the sheet, with the reveal beside it (#1476).
///
/// The fresher's counterpart to `_EmploymentEntry`: the printed line, and —
/// only when a model rewrote it — a quiet link to see the sentence he actually
/// wrote. Stateful for exactly the same reason that one is: the reveal is a
/// LOCAL toggle and must not reset every time the tab rebuilds.
///
/// THE REFUSAL SHIPS TOO now (#1492). #1476 gave him only the reveal, because
/// at the time there was no column and no route to call — a button that
/// silently failed would have been worse than none, since he would have
/// believed he had kept his words. Migration 0103 and
/// `PUT /workers/me/answers/:attributeKey/text-source` both landed, so he can
/// act on the comparison rather than only look at it.
///
/// ONE-WAY FROM HERE, and deliberately symmetric with #1354: after a refusal
/// the server has nothing left to compare, so `work_own_words` and
/// `own_words_key` both drop out of the next document and the affordance
/// disappears. The employment path behaves identically. A change-your-mind
/// toggle would need the document to carry the declined STATE rather than just
/// the comparison — a backend change, on both paths at once, not something to
/// fake here.
class _TrainingEntry extends StatefulWidget {
  const _TrainingEntry({required this.line});

  final ResumeExperienceLineDto line;

  @override
  State<_TrainingEntry> createState() => _TrainingEntryState();
}

class _TrainingEntryState extends State<_TrainingEntry> {
  bool _revealed = false;

  /// True while the refusal is in flight, so a second tap cannot fire it twice.
  bool _pending = false;

  Future<void> _keepOwnWords() async {
    final String? key = widget.line.ownWordsKey;
    if (key == null || _pending) return;
    setState(() => _pending = true);
    try {
      await context.read<ResumeCubit>().setAnswerTextSource(key, ownWords: true);
      if (!mounted) return;
      // Nothing left to compare once the printed line already IS his own
      // words — collapse rather than leave a panel showing two equal strings.
      setState(() => _revealed = false);
    } on Failure catch (f) {
      // He tapped a deliberate choice about a sentence carrying his name. A
      // failed write must surface honestly, never look like it silently
      // worked — the same rule `_EmploymentEntry._choose` follows.
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
    final ResumeExperienceLineDto line = widget.line;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (line.role.isNotEmpty)
          Text(
            line.role,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              weight: FontWeight.w700,
            ),
          ),
        if (line.duration.isNotEmpty)
          Text(
            line.duration,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
        if (line.work.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s1),
          Text(
            line.work,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textPrimary,
            ),
          ),
        ],
        // Nothing to compare ⇒ nothing extra. No affordance, no greyed
        // placeholder — the same rule the employment entry follows.
        //
        // `canRefuseRewrite`, not `hasOwnWords`: the words AND the address
        // arrive together or not at all (see the DTO), so this is the one
        // condition — and it keeps the button off screen in the impossible
        // state where a comparison has no key to send the refusal to.
        if (line.canRefuseRewrite) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          _OwnWordsChoice(
            revealed: _revealed,
            pending: _pending,
            ownWordsText: line.workOwnWords!,
            onToggle: () => setState(() => _revealed = !_revealed),
            onKeep: _keepOwnWords,
          ),
        ],
      ],
    );
  }
}

/// any warning styling) — keeping one's own words is a first-class choice,
/// not a downgrade, and needs no "are you sure".
class _OwnWordsChoice extends StatelessWidget {
  const _OwnWordsChoice({
    required this.revealed,
    required this.pending,
    required this.ownWordsText,
    required this.onToggle,
    this.onKeep,
  });

  final bool revealed;
  final bool pending;
  final String ownWordsText;
  final VoidCallback onToggle;

  /// Null when the choice cannot be PERSISTED yet, which is the fresher's
  /// training block today (#1476): the sheet now shows him what his sentence
  /// was rewritten from, but there is no per-worker decline for that path —
  /// `work_done_polish_declined` is a column on the employment role, and the
  /// attribute equivalent needs a migration. A button that silently failed to
  /// keep his words would be worse than no button, so it is simply absent.
  final VoidCallback? onKeep;

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
                if (onKeep != null) ...<Widget>[
                  const SizedBox(height: AppSpacing.s3),
                  BbButton(
                    label: 'Apne shabd rakhein',
                    onPressed: onKeep,
                    variant: BbButtonVariant.tonal,
                    size: BbButtonSize.md,
                    loading: pending,
                  ),
                ],
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
              // FLEXIBLE, and it has to be: "Aapke apne shabdon mein dekhein"
              // beside its icon overflowed a 360dp phone by 128px — a real
              // RenderFlex error on the narrowest handset the product targets.
              // The existing tests never saw it because a widget test's default
              // surface is 800dp wide. It wraps to a second line now rather
              // than being clipped.
              Flexible(
                child: Text(
                  label,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w700,
                    color: AppColors.textBrand,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
