import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart' show ResumeHistoryItem;
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/date_label.dart';
import '../../../../core/widgets/kit/kit_pill.dart';
import '../../../profile_tab/domain/profile_summary.dart';
import 'resume_history_section.dart';

/// "A4 Format" — true of every résumé this app produces: the PDF template is a
/// fixed A4 sheet (`apps/api` renders one size). Stated, not measured.
const String kResumeFormatChip = 'A4 Format';

/// The verification line, from the profile's OWN verified/attested flags.
const String kResumeVerifiedNote = 'Complete Verification Done';
const String kResumeUnverifiedNote = 'Verification baaki hai';

/// One saved résumé card (design: Mere resume).
///
/// WHERE EACH FACT COMES FROM, in strict precedence:
///
///  1. **The row itself.** Once backend #1714 ships, `GET /resume/history`
///     carries this résumé's OWN `trade_label`, `experience_years`,
///     `machines`, `city`, `page_count` and `display_ref`. Those are correct
///     for every card, old or current, and are preferred over everything else.
///  2. **The profile summary, for the CURRENT résumé only.** Today the history
///     row carries none of the above, so the current card reads them from
///     `GET /workers/me/profile-summary` — the one card where "the profile the
///     worker has now" and "the profile this résumé was made from" are the
///     same thing.
///  3. **What the wire always said**: the flow that made it, when, and whether
///     its PDF exists.
///
/// An OLDER résumé never borrows today's profile. It was generated from a
/// different one — that is exactly what `profile_id` records — so printing
/// today's trade and city on it would tell the worker that a résumé contains
/// facts it does not.
class ResumeFileCard extends StatelessWidget {
  const ResumeFileCard({
    super.key,
    required this.item,
    required this.summary,
    required this.actions,
  });

  final ResumeHistoryItem item;

  /// The worker's CURRENT profile, or null when it has not loaded (or failed —
  /// the card then simply shows fewer facts, never an error).
  final ProfileSummary? summary;

  final Widget actions;

  /// The trade THIS résumé was written for.
  ///
  /// Prefers the row's OWN `trade_label` (backend #1714) — correct for every
  /// card, old or current. Falls back to the profile summary for the current
  /// résumé only, which is the one card where today's profile IS this
  /// résumé's. Last resort: the flow that made it, the only thing an older row
  /// says about itself on a server that has not shipped #1714 yet.
  String get _title {
    final String? own = item.tradeLabel;
    if (own != null && own.trim().isNotEmpty) return own;
    final String? trade = summary?.tradeLabel;
    if (item.isCurrent && trade != null && trade.trim().isNotEmpty) {
      return trade;
    }
    final String? source = resumeSourceLabel(item.source);
    return source == null ? 'Resume' : '$source se bana resume';
  }

  /// "3.5 Yrs • Fanuc & Siemens • Pune MIDC" — each part omitted when it is not
  /// known, so the line never pads itself with blanks.
  ///
  /// Same precedence as [_title]: the row's own facts first (#1714), then the
  /// profile summary for the CURRENT résumé only. An older résumé never
  /// borrows today's profile — it was generated from a different one.
  List<String> get _facts {
    if (item.experienceYears != null ||
        item.machines.isNotEmpty ||
        (item.city != null && item.city!.trim().isNotEmpty)) {
      return <String>[
        if (item.experienceYears != null) _years(item.experienceYears!),
        if (item.machines.isNotEmpty) item.machines.take(2).join(' & '),
        if (item.city != null && item.city!.trim().isNotEmpty) item.city!,
      ];
    }
    final ProfileSummary? s = summary;
    if (s == null || !item.isCurrent) return const <String>[];
    return <String>[
      if (s.experienceYears != null) _years(s.experienceYears!),
      if (s.machines.isNotEmpty) s.machines.take(2).join(' & '),
      if (s.city != null && s.city!.trim().isNotEmpty) s.city!,
    ];
  }

  /// "3.5 Yrs" / "2 Yrs" — no trailing `.0` on a whole number of years.
  static String _years(double years) {
    final String n = years == years.roundToDouble()
        ? years.toInt().toString()
        : years.toStringAsFixed(1);
    return '$n Yrs';
  }

  @override
  Widget build(BuildContext context) {
    final List<String> facts = _facts;
    final DateTime? made = item.generatedAt;
    final ProfileSummary? s = summary;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(
          color: item.isCurrent
              ? OnboardingColors.borderActive
              : Colors.transparent,
          width: 2,
        ),
      ),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: OnboardingColors.paperWhite,
          borderRadius: BorderRadius.circular(OnboardingRadii.card),
          border: Border.all(color: OnboardingColors.borderDefault),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            // The icon column and the TEXT column. The title sits in the
            // text column, directly under the pills and sharing their left
            // edge — not full-width under the whole row, which left it
            // hanging under the icon and out of line with everything else.
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const _DocTile(),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Expanded(
                            child: Wrap(
                              spacing: 6,
                              runSpacing: 6,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: <Widget>[
                                _StatusPill(item: item),
                                if (item.isCurrent)
                                  const KitPill(
                                    label: 'LATEST',
                                    tone: KitPillTone.neutral,
                                  )
                                else if (item.displayRef != null &&
                                    item.displayRef!.trim().isNotEmpty)
                                  // The design's `ID: #BB-8492`. ONLY from the
                                  // server's short `display_ref` (#1714) —
                                  // never `resume_id`, which is a uuid.
                                  KitPill(
                                    label: 'ID: ${item.displayRef}',
                                    tone: KitPillTone.neutral,
                                  )
                                else if (resumeSourceLabel(item.source) != null)
                                  KitPill(
                                    label: resumeSourceLabel(
                                      item.source,
                                    )!.toUpperCase(),
                                    tone: KitPillTone.neutral,
                                  ),
                              ],
                            ),
                          ),
                          if (made != null) ...<Widget>[
                            const SizedBox(width: 8),
                            _DateStamp(when: made),
                          ],
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: OnboardingTypography.anek(
                          size: 16,
                          weight: FontWeight.w800,
                          color: OnboardingColors.ink900,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (facts.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              const Divider(height: 1, color: OnboardingColors.borderSubtle),
              const SizedBox(height: 10),
              _FactLine(facts: facts),
            ],
            if (facts.isNotEmpty) ...<Widget>[
              const SizedBox(height: 8),
              _SpecRow(
                pageCount: item.pageCount,
                verified: item.isCurrent && s != null
                    ? (s.verified || s.attested)
                    : null,
              ),
            ],
            const SizedBox(height: 12),
            const Divider(height: 1, color: OnboardingColors.borderSubtle),
            const SizedBox(height: 12),
            actions,
          ],
        ),
      ),
    );
  }
}

class _DocTile extends StatelessWidget {
  const _DocTile();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 44,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: OnboardingColors.shieldCircle,
        borderRadius: BorderRadius.circular(10),
      ),
      child: const Icon(
        Icons.description_outlined,
        size: 22,
        color: OnboardingColors.shiftBlue,
      ),
    );
  }
}

class _DateStamp extends StatelessWidget {
  const _DateStamp({required this.when});

  final DateTime when;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const Icon(
          Icons.calendar_today_outlined,
          size: 12,
          color: OnboardingColors.ink500,
        ),
        const SizedBox(width: 5),
        Text(
          shortDateLabel(when),
          style: OnboardingTypography.mono(
            size: 11,
            weight: FontWeight.w600,
            color: OnboardingColors.ink600,
          ),
        ),
      ],
    );
  }
}

/// "Exp:  3.5 Yrs • Fanuc & Siemens • Pune MIDC"
class _FactLine extends StatelessWidget {
  const _FactLine({required this.facts});

  final List<String> facts;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          'Exp:',
          style: OnboardingTypography.inter(
            size: 12,
            weight: FontWeight.w700,
            color: OnboardingColors.ink500,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            facts.join(' • '),
            style: OnboardingTypography.inter(
              size: 12,
              weight: FontWeight.w600,
              height: 1.4,
              color: OnboardingColors.ink900,
            ),
          ),
        ),
      ],
    );
  }
}

/// "[A4 Format] • Complete Verification Done"
///
/// The design also carries a page count. The server sends none — neither the
/// history row nor the document read reports how many pages the rendered PDF
/// has — so the slot is left out rather than filled with a guessed number.
class _SpecRow extends StatelessWidget {
  const _SpecRow({required this.pageCount, required this.verified});

  /// "2 Pages". Null until the server reports it (#1714) — the slot is then
  /// left out rather than filled with a guessed number.
  final int? pageCount;

  /// Null when this résumé's verification state is not known — an older row on
  /// a server without #1714. The note is then omitted rather than claimed.
  final bool? verified;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: <Widget>[
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: OnboardingColors.pillMutedBg,
            borderRadius: BorderRadius.circular(OnboardingRadii.pillSm),
          ),
          child: Text(
            kResumeFormatChip,
            style: OnboardingTypography.inter(
              size: 11,
              weight: FontWeight.w600,
              color: OnboardingColors.ink600,
            ),
          ),
        ),
        if (pageCount != null && pageCount! > 0)
          Text(
            '• $pageCount ${pageCount == 1 ? 'Page' : 'Pages'}',
            style: OnboardingTypography.inter(
              size: 11,
              weight: FontWeight.w500,
              color: OnboardingColors.ink500,
            ),
          ),
        if (verified != null)
          Text(
            '• ${verified! ? kResumeVerifiedNote : kResumeUnverifiedNote}',
            style: OnboardingTypography.inter(
              size: 11,
              weight: FontWeight.w500,
              color: OnboardingColors.ink500,
            ),
          ),
      ],
    );
  }
}

/// READY / still rendering / failed, fail-closed (ruling R6).
class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.item});

  final ResumeHistoryItem item;

  @override
  Widget build(BuildContext context) {
    if (item.isRendered) {
      return const KitPill(label: '● READY', tone: KitPillTone.green);
    }
    if (item.hasFailedRender) {
      return const KitPill(label: '● NAHI BANI', tone: KitPillTone.red);
    }
    return const KitPill(label: '● BAN RAHA HAI', tone: KitPillTone.neutral);
  }
}
