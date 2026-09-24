import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/date_label.dart';
import '../../../../core/widgets/kit/kit_card.dart';
import '../../../../core/widgets/kit/kit_micro_label.dart';
import '../../../../core/widgets/kit/kit_pill.dart';
import '../../../../core/widgets/onboarding/primary_action_button.dart';

/// The heading over the older resumes (#1687).
const String kResumeHistoryTitle = 'Pichle resume';

/// How many history cards this section will ever draw.
///
/// The server already windows the list, so in practice this changes nothing.
/// It is here because the acceptance criterion is stated about the APP ("3 or
/// more rows → 3 cards"): if the window is ever widened server-side, the tab
/// must not silently grow an unbounded list of cards under the resume.
const int kResumeHistoryMaxCards = 3;

/// The waiting / failed copy for an update the worker accepted in chat (#1688).
const String kResumeUpdateInProgress = 'Resume update ho raha hai…';
const String kResumeUpdateInProgressNote =
    'Aapki nayi jaankari se naya resume ban raha hai. Thodi der lagti hai.';
const String kResumeUpdateFailed = 'Resume update nahi ho paaya.';
const String kResumeUpdateFailedNote =
    'Aap profile dekh kar dobara confirm kar sakte hain.';
const String kResumeUpdateRetryLabel = 'Dobara koshish karein';
const String kResumeUpdateLanded = 'Naya resume taiyaar hai';

/// The human label for a [ResumeSource].
///
/// NULL for an absent source (a legacy row) AND for [ResumeSource.unknown] —
/// both mean "we cannot honestly name the flow that made this", and the card
/// then shows NO badge rather than a guess or a raw token. The raw wire strings
/// (`form`, `chat`, `resume_upload`) must never reach a worker's screen.
String? resumeSourceLabel(ResumeSource? source) => switch (source) {
  ResumeSource.form => 'Form',
  ResumeSource.chat => 'Chat',
  ResumeSource.resumeUpload => 'Resume upload',
  ResumeSource.unknown || null => null,
};

/// The status pill for one history entry: ready, still rendering, or failed.
///
/// Fails closed, ruling R6: only an explicit `rendered` is READY and only an
/// explicit `failed` is a failure. An unknown or absent token reads as "still
/// working", which is the honest answer when the server has not said.
({String label, KitPillTone tone}) _statusPill(ResumeHistoryItem item) {
  if (item.isRendered) {
    return (label: 'READY', tone: KitPillTone.green);
  }
  if (item.hasFailedRender) {
    return (label: 'NAHI BANI', tone: KitPillTone.red);
  }
  return (label: 'BAN RAHA HAI', tone: KitPillTone.neutral);
}

/// "Pichle resume" — up to the newest few resumes the worker has, each with the
/// flow that made it, when it was made, whether its PDF exists, and its OWN
/// download + share actions (#1687).
///
/// The order is the SERVER'S: this widget does not re-sort or renumber. It
/// does hold its own ceiling of [kResumeHistoryMaxCards] — a bound on the
/// drawing, never a reordering of it. It deliberately shows NO version number —
/// `version` is counted per profile, not per history, so the newest card can
/// honestly be "v1" while an older one is "v3", and printing it would read as
/// a contradiction.
///
/// Renders NOTHING when there is nothing to show, so a worker on a server
/// without the route (or with a single resume) sees the tab exactly as it was
/// before this feature existed.
class ResumeHistorySection extends StatelessWidget {
  const ResumeHistorySection({
    super.key,
    required this.history,
    required this.actionsBuilder,
  });

  final ResumeHistory history;

  /// Builds the per-entry actions. Injected rather than built here so this
  /// widget stays presentation-only and the screen keeps owning the download /
  /// share machinery (the signed-url minting, the 409 render window, the native
  /// share boundary) in one place.
  final Widget Function(ResumeHistoryItem item) actionsBuilder;

  @override
  Widget build(BuildContext context) {
    final List<ResumeHistoryItem> items = history.items
        .take(kResumeHistoryMaxCards)
        .toList(growable: false);
    if (items.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const KitMicroLabel(kResumeHistoryTitle),
        const SizedBox(height: 8),
        for (int i = 0; i < items.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(height: 10),
          _HistoryCard(item: items[i], actions: actionsBuilder(items[i])),
        ],
      ],
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.item, required this.actions});

  final ResumeHistoryItem item;
  final Widget actions;

  @override
  Widget build(BuildContext context) {
    final String? badge = resumeSourceLabel(item.source);
    final ({String label, KitPillTone tone}) status = _statusPill(item);
    final DateTime? made = item.generatedAt;
    return DecoratedBox(
      // The CURRENT entry is marked by a safety-yellow ring around the same
      // flat kit card — the system's own "this one is selected" signal. No
      // shadow and no second fill: elevation 0 is the rule here.
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(
          color: item.isCurrent
              ? OnboardingColors.borderActive
              : Colors.transparent,
          width: 2,
        ),
      ),
      child: KitCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                if (badge != null) ...<Widget>[
                  KitPill(label: badge.toUpperCase(), tone: KitPillTone.yellow),
                  const SizedBox(width: 8),
                ],
                KitPill(label: status.label, tone: status.tone),
                const Spacer(),
                if (made != null)
                  Flexible(
                    child: Text(
                      absoluteDateLabel(made),
                      textAlign: TextAlign.right,
                      style: OnboardingTypography.inter(
                        size: 12,
                        weight: FontWeight.w600,
                        color: OnboardingColors.ink600,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            actions,
          ],
        ),
      ),
    );
  }
}

/// The state of an update the worker accepted in chat (#1688): still on its
/// way, or terminally not happening.
///
/// The failure card always carries a way forward — the ordinary profile
/// preview → confirm path, which works whether or not the update route does.
/// A worker is never left with a failure and no next step.
class ResumeUpdateCard extends StatelessWidget {
  const ResumeUpdateCard({super.key, required this.failed, this.onRetry});

  final bool failed;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              SizedBox(
                width: 20,
                height: 20,
                child: failed
                    ? const Icon(
                        Icons.error_outline_rounded,
                        size: 20,
                        color: OnboardingColors.errorRed,
                      )
                    : const CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: OnboardingColors.shiftBlue,
                      ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  failed ? kResumeUpdateFailed : kResumeUpdateInProgress,
                  style: OnboardingTypography.cardTitle(
                    color: failed
                        ? OnboardingColors.errorRed
                        : OnboardingColors.shiftBlue,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            failed ? kResumeUpdateFailedNote : kResumeUpdateInProgressNote,
            style: OnboardingTypography.inter(
              size: 12,
              height: 1.4,
              color: OnboardingColors.ink600,
            ),
          ),
          if (failed && onRetry != null) ...<Widget>[
            const SizedBox(height: 12),
            PrimaryActionButton(
              label: kResumeUpdateRetryLabel,
              showArrow: false,
              onPressed: onRetry,
            ),
          ],
        ],
      ),
    );
  }
}
