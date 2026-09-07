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

/// Which layout a [BbJobCard] renders.
///
/// The SAME data and the SAME semantics labels, arranged for two genuinely
/// different jobs — so the deck stops borrowing a row built for a list.
///
///  - [list] — the compact vertical-feed row (unchanged, the default).
///  - [deck] — the swipe card: it OWNS a full screen, so the facts a worker
///    decides on (pay, shift) get real size instead of list-row type, and the
///    card fills its space rather than floating at the top of an empty one.
enum BbJobCardLayout { list, deck }

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
    this.layout = BbJobCardLayout.list,
  });

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  /// Which arrangement to render — see [BbJobCardLayout]. Defaults to the
  /// list row, so every existing call site is untouched.
  final BbJobCardLayout layout;

  /// Fired by the green `APPLY →` action. When null the action is not rendered
  /// (the salary row shows [BbJobCardData.metaRight] instead, if present).
  final VoidCallback? onApply;

  bool get _hasSalaryRow =>
      data.payBand != null ||
      onApply != null ||
      data.effectiveMetaRight != null;

  @override
  Widget build(BuildContext context) {
    final bool isDeck = layout == BbJobCardLayout.deck;
    // The deck card owns a full screen, so it gets the roomier radius/padding
    // and stretches; the list row keeps exactly the geometry it always had.
    final double radius = isDeck ? AppRadii.md : AppRadii.sm;
    return Container(
      margin: const EdgeInsets.fromLTRB(
        AppSpacing.s3,
        0,
        AppSpacing.s3,
        AppSpacing.s2,
      ),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
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
            padding: EdgeInsets.all(isDeck ? AppSpacing.s5 : AppSpacing.s3),
            child: isDeck
                ? _DeckBody(data: data, onTitleTap: onTitleTap)
                : Column(
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

// ── The DECK layout ─────────────────────────────────────────────────────────
//
// Same data, same semantics labels, arranged for a card that owns a screen.
//
// WHY IT IS NOT THE LIST ROW. The deck used to render the list row verbatim,
// so a card with a whole screen to fill showed a 15px title and a 16px pay
// figure crammed into the top ~120px with dead space beneath — the layout read
// as unfinished because it WAS a row, stretched. Here the two facts a worker
// actually decides on (pay, shift) get real size in their own panel, and the
// card fills its box instead of floating at the top of an empty one.
//
// NO SHADOW, and that is not an oversight: this system separates surfaces with
// hairline borders and flat fills only (`app_theme.dart` — "hairline borders,
// never shadows; every elevation is 0"). Depth here comes from a tint panel and
// a border, never an elevation.

/// The swipe card's body: title, place, a key-facts panel, the match note, and
/// a swipe hint pinned to the bottom.
class _DeckBody extends StatelessWidget {
  const _DeckBody({required this.data, required this.onTitleTap});

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  /// Anek display, big enough to be the card's anchor — the list row's 15px
  /// body title is a row heading, not a card heading.
  Text _title() => Text(
        data.title,
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
        style: AppTypography.display(
          size: 22,
          weight: FontWeight.w800,
          color: AppColors.textPrimary,
          height: 1.15,
        ),
      );

  @override
  Widget build(BuildContext context) {
    final String? meta = data.effectiveMetaRight;
    final bool hasFacts = data.payBand != null || meta != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            // #362 — the title stays the ONLY route into the job detail from a
            // deck card (the pan recognizer claims the rest), so it keeps the
            // same ≥48px button, key and TalkBack label as the list row.
            Expanded(
              child: onTitleTap == null
                  ? _title()
                  : _TitleButton(onTap: onTitleTap!, title: _title()),
            ),
            if (data.hot) ...<Widget>[
              const SizedBox(width: AppSpacing.s2),
              const BbHotTag(),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.s1),
        _DeckPlaceRow(data: data),
        if (hasFacts) ...<Widget>[
          const SizedBox(height: AppSpacing.s4),
          _DeckFactsPanel(payBand: data.payBand, meta: meta),
        ],
        if (data.matchNote != null) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          _DeckMatchNote(text: data.matchNote!),
        ],
        // Pushes the hint to the bottom so the card FILLS its box. Flexible,
        // not Expanded: on a short card the content wins and the hint simply
        // sits under it rather than forcing an overflow.
        const Flexible(child: SizedBox(height: AppSpacing.s4)),
        const _DeckSwipeHint(),
      ],
    );
  }
}

/// Place (with the employer when one exists) behind a pin icon.
class _DeckPlaceRow extends StatelessWidget {
  const _DeckPlaceRow({required this.data});

  final BbJobCardData data;

  @override
  Widget build(BuildContext context) {
    final String line =
        data.company == null ? data.place : '${data.company} · ${data.place}';
    return Row(
      children: <Widget>[
        const Icon(Icons.place_outlined, size: 16, color: AppColors.textMuted),
        const SizedBox(width: 5),
        Flexible(
          child: Text(
            line,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textSecondary,
            ),
          ),
        ),
        if (data.verified) ...<Widget>[
          const SizedBox(width: 4),
          const Icon(Icons.verified, size: 15, color: AppColors.blue),
        ],
      ],
    );
  }
}

/// The two facts a worker decides on, in one haldi-tinted panel: the pay at
/// display size on the left, the shift (already on the model, and dropped by
/// the list row) muted on the right.
class _DeckFactsPanel extends StatelessWidget {
  const _DeckFactsPanel({required this.payBand, required this.meta});

  final String? payBand;
  final String? meta;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s3,
        vertical: AppSpacing.s3,
      ),
      decoration: BoxDecoration(
        // Haldi wash + a saffron hairline: warmth and separation with no
        // elevation, per the system's flat rule.
        color: AppColors.haldiTint,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        border: Border.all(color: AppColors.saffron200),
      ),
      // WRAP, not a Row with a Spacer. A 26px pay figure beside a long shift
      // ("Rotational shift") overflows a 320px handset by ~52px, and neither
      // fact is one to ellipsize: the shift drops to its own line instead.
      child: Wrap(
        spacing: AppSpacing.s4,
        runSpacing: AppSpacing.s2,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: <Widget>[
          if (payBand != null)
            Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: <Widget>[
                Text(
                  payBand!,
                  maxLines: 1,
                  style: AppTypography.display(
                    size: 26,
                    weight: FontWeight.w800,
                  ),
                ),
                Text(
                  ' /mah',
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          if (meta != null)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(Icons.schedule,
                    size: 15, color: AppColors.textMuted),
                const SizedBox(width: 4),
                Text(
                  meta!,
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textSecondary,
                    weight: FontWeight.w700,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// E18's "why am I seeing this" line, given its own quiet blue panel so it
/// reads as an explanation rather than another job fact.
class _DeckMatchNote extends StatelessWidget {
  const _DeckMatchNote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: AppColors.blueTintChat,
        borderRadius: BorderRadius.circular(AppRadii.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.info_outline, size: 16, color: AppColors.blue),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              text,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The gesture, spelled out. A worker who has never met a card deck cannot
/// discover swipe from a static card, and the two big buttons below are the
/// primary affordance for exactly that reason — this names the shortcut in the
/// same words the buttons use, in muted meta type so it never competes with
/// the job itself.
class _DeckSwipeHint extends StatelessWidget {
  const _DeckSwipeHint();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.arrow_back, size: 14, color: AppColors.textMuted),
            const SizedBox(width: 4),
            Text('Skip',
                style: AppTypography.body(
                  size: AppTypography.size2xs,
                  color: AppColors.textMuted,
                  weight: FontWeight.w700,
                )),
          ],
        ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('Apply',
                style: AppTypography.body(
                  size: AppTypography.size2xs,
                  color: AppColors.success,
                  weight: FontWeight.w700,
                )),
            const SizedBox(width: 4),
            const Icon(Icons.arrow_forward,
                size: 14, color: AppColors.success),
          ],
        ),
      ],
    );
  }
}
