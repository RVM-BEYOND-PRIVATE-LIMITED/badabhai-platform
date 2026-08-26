import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_tag.dart';

/// Immutable contents of a [BbJobCard] — the worker-facing job summary the feed
/// renders. Pure data, no behaviour.
class BbJobCardData {
  const BbJobCardData({
    required this.title,
    this.company,
    this.verified = false,
    this.payBand,
    required this.place,
    this.shift,
    this.tags = const <String>[],
    this.spotsLeft,
    this.matchNote,
    this.hot = false,
    this.metaRight,
  });

  final String title;

  /// Employer name — NULL on the real feed. Employer names are PII (CLAUDE.md
  /// §2) and `GET /feed` deliberately does not return one. Optional (and unset
  /// in production) because an earlier build invented a company name per card
  /// from `jobId.hashCode` and rendered it as fact.
  final String? company;

  /// Pay band — the card's salary. NULL when no source supplies it (the salary
  /// row is then omitted, never invented).
  final String? payBand;

  final String place;

  /// Shift — retained on the model; not rendered on the compact list card.
  final String? shift;

  /// Only ever shown for a REAL employer; never a badge on an invented name.
  final bool verified;

  /// Requirement tags — retained on the model; not rendered on the compact list
  /// card (the job-detail screen renders them).
  final List<String> tags;

  /// Remaining spots — retained on the model; surface it via [metaRight] if a
  /// screen wants it on the card.
  final int? spotsLeft;

  /// Matching V1 / E18 (ADR-0036): WHY this job is in the worker's feed, when
  /// the reason is not simply "you have this skill".
  ///
  /// Shown only for a RELATED match, because that is the case a man would
  /// otherwise find confusing — a lathe job appearing for someone who listed
  /// VMC work reads as a mistake unless we say why. An exact match needs no
  /// explanation, so it gets none rather than a line of noise on every card.
  ///
  /// NULL is the honest default: on the legacy feed, and whenever the server
  /// did not name the matched skill, the card says nothing instead of guessing.
  final String? matchNote;

  /// Featured / urgent: draws the 4px haldi left rail and a [BbHotTag]. EARNED,
  /// never uniform — set only for a genuinely featured posting.
  final bool hot;

  /// Muted right-hand meta on the salary row, shown when [BbJobCard.onApply] is
  /// not wired (e.g. "General shift", "Sirf 4 seat baaki"). When null the card
  /// falls back to [shift] for this slot (the kit uses the meta slot for shift).
  final String? metaRight;

  /// The value the card shows in its right-hand meta slot: an explicit
  /// [metaRight] wins, otherwise [shift].
  String? get effectiveMetaRight => metaRight ?? shift;
}

/// TalkBack label for the title button. Hinglish, matching the app voice and the
/// `Semantics(button: true, label: ...)` pattern the voice screen already ships.
const String kJobCardTitleSemanticLabel = 'Job kholein — poori jaankari';

/// TalkBack label for the APPLY action.
const String kJobCardApplySemanticLabel = 'Apply karein';

/// The job card — the kit's LIST `JobCard`. Crisp white paper, one hairline
/// border, radius 10, elevation 0. A featured/urgent posting ([BbJobCardData.hot])
/// earns a 4px haldi LEFT RAIL and a [BbHotTag]; nothing else does.
///
/// Layout: title, then "company · location" with an optional verified tick, then
/// a bottom row of the salary (Anek, `/mah` muted) on the left and either a green
/// Anek `APPLY →` action ([onApply]) or a muted [BbJobCardData.metaRight] on the
/// right. Designed for a VERTICAL LIST feed.
///
/// Pass [onTitleTap] to make the title open the job detail (an accessible ≥48px
/// button, #362); pass [onApply] to wire the APPLY action.
class BbJobCard extends StatelessWidget {
  const BbJobCard({
    super.key,
    required this.data,
    this.onTitleTap,
    this.onApply,
  });

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  /// Fired by the green `APPLY →` action. When null the action is not rendered
  /// (the salary row shows [BbJobCardData.metaRight] instead, if present).
  final VoidCallback? onApply;

  bool get _hasSalaryRow =>
      data.payBand != null ||
      onApply != null ||
      data.effectiveMetaRight != null;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.s3,
        0,
        AppSpacing.s3,
        AppSpacing.s2,
      ),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadii.sm),
        child: DecoratedBox(
          // Haldi left rail on featured/urgent cards ONLY — earned, never uniform.
          decoration: BoxDecoration(
            border: data.hot
                ? const Border(
                    left: BorderSide(
                      color: AppColors.haldi,
                      width: AppSpacing.s1, // 4px rail (kit railWidth)
                    ),
                  )
                : null,
          ),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.s3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                _HeaderRow(data: data, onTitleTap: onTitleTap),
                // E18 — the "why am I seeing this" line, only for a related match.
                if (data.matchNote != null) ...<Widget>[
                  const SizedBox(height: AppSpacing.s2),
                  Text(
                    data.matchNote!,
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
                if (_hasSalaryRow) ...<Widget>[
                  const SizedBox(height: AppSpacing.s2),
                  _SalaryRow(data: data, onApply: onApply),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Title (left, flexes) + optional [BbHotTag] (right).
class _HeaderRow extends StatelessWidget {
  const _HeaderRow({required this.data, required this.onTitleTap});

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              // #362 — in a swipe deck this title is the ONLY route to the job
              // detail (the pan recognizer claims the rest of the card), so it
              // must be a real ≥48px button, not a bare tap on a text line.
              // Static cards (no callback) keep a plain, non-interactive title.
              if (onTitleTap == null)
                _titleText(data.title)
              else
                _TitleButton(onTap: onTitleTap!, title: _titleText(data.title)),
              const SizedBox(height: 2),
              _SubtitleRow(data: data),
            ],
          ),
        ),
        if (data.hot) ...<Widget>[
          const SizedBox(width: AppSpacing.s2),
          const BbHotTag(),
        ],
      ],
    );
  }

  // Kit `cardTitle` — Roboto bold 15 ink, tight leading. Compact list rows read
  // in body-strong, not the big Anek display voice (which is for the detail).
  Text _titleText(String title) => Text(
        title,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: AppTypography.body(
          size: 15,
          weight: FontWeight.w700,
          color: AppColors.textPrimary,
          height: 1.25,
        ),
      );
}

/// "company · location" with an optional blue verified tick. On the real feed
/// [BbJobCardData.company] is null, so only the location shows.
class _SubtitleRow extends StatelessWidget {
  const _SubtitleRow({required this.data});

  final BbJobCardData data;

  @override
  Widget build(BuildContext context) {
    final String line =
        data.company == null ? data.place : '${data.company} · ${data.place}';
    return Row(
      children: <Widget>[
        Flexible(
          child: Text(
            line,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textSecondary,
            ),
          ),
        ),
        if (data.verified) ...<Widget>[
          const SizedBox(width: 3),
          const Icon(Icons.verified, size: 14, color: AppColors.blue),
        ],
      ],
    );
  }
}

/// Salary (Anek + muted `/mah`) on the left; the green `APPLY →` action or a
/// muted meta line on the right.
class _SalaryRow extends StatelessWidget {
  const _SalaryRow({required this.data, required this.onApply});

  final BbJobCardData data;
  final VoidCallback? onApply;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        // Salary — Anek number + muted "/mah". Two Texts (not a rich span) so the
        // bare pay string stays selectable/findable and the baseline aligns.
        if (data.payBand != null)
          Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: <Widget>[
              Text(
                data.payBand!,
                style: AppTypography.display(size: 16, weight: FontWeight.w800),
              ),
              Text(
                ' /mah',
                style: AppTypography.body(
                  size: AppTypography.size2xs,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          )
        else
          const SizedBox.shrink(),
        if (onApply != null)
          _ApplyAction(onApply: onApply!)
        else if (data.effectiveMetaRight != null)
          Text(
            data.effectiveMetaRight!,
            style: AppTypography.body(
              size: AppTypography.size2xs,
              color: AppColors.textMuted,
            ),
          ),
      ],
    );
  }
}

/// Green Anek `APPLY →` — the kit's card-level apply action, wrapped in a
/// transparent [Material] so its ripple is visible over the opaque card fill.
class _ApplyAction extends StatelessWidget {
  const _ApplyAction({required this.onApply});

  final VoidCallback onApply;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: kJobCardApplySemanticLabel,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: const Key('jobCardApplyButton'),
          onTap: onApply,
          borderRadius: BorderRadius.circular(AppRadii.sm),
          // ≥48px (AppSpacing.tap) hit target — the primary conversion action
          // must clear the worker tap floor, same as _TitleButton. Center keeps
          // the label where it was while the hit area grows to 48px.
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: AppSpacing.tap),
            child: Center(
              widthFactor: 1,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s2),
                child: Text(
                  'APPLY →',
                  style: AppTypography.display(
                    size: 13,
                    weight: FontWeight.w800,
                    color: AppColors.success,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The job title as a proper button (#362): a ≥48px (`AppSpacing.tap`) hit
/// target, a visible ripple, a chevron so a low-literacy worker can SEE it opens
/// something, and a button role + Hinglish label for TalkBack.
class _TitleButton extends StatelessWidget {
  const _TitleButton({required this.onTap, required this.title});

  final VoidCallback onTap;
  final Widget title;

  @override
  Widget build(BuildContext context) {
    // MergeSemantics collapses the title Text + this annotation into ONE node,
    // so TalkBack reads "<job title>, job kholein — poori jaankari, button" as a
    // single focusable button. Without it the Text keeps its own node and the
    // label is dropped, which is exactly the "announced as plain text" defect.
    return MergeSemantics(
      child: Semantics(
        button: true,
        label: kJobCardTitleSemanticLabel,
        child: Material(
          // The card is a plain DecoratedBox with an OPAQUE white fill, so
          // without a local transparent Material the ink would splash on the
          // Scaffold underneath the card and never be seen.
          type: MaterialType.transparency,
          child: InkWell(
            key: const Key('jobCardTitleButton'),
            onTap: onTap,
            borderRadius: BorderRadius.circular(AppRadii.sm),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: AppSpacing.tap),
              child: Row(
                children: <Widget>[
                  Expanded(child: title),
                  const SizedBox(width: AppSpacing.s2),
                  const Icon(
                    Icons.chevron_right,
                    size: 22,
                    color: AppColors.brandPress,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
