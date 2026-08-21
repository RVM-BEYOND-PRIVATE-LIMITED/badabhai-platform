import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_stat.dart';
import '../../../core/widgets/payer_role_badge.dart';

/// Home — the identity header, the REAL credit balance, and the two real
/// actions (Post a job · Browse candidates).
///
/// Everything else this screen used to show was fabricated: the "paid unlocks
/// this week" hero, the repeat-unlock-rate / active-jobs / candidates-for-you
/// grid, the agency Earn·Supply ₹ card, and the "Recent activity" feed (which
/// invented rows like "Unlocked Ramesh K. · CNC Setter"). None had a backend
/// route — they were served by a mock the real HTTP client delegated to — so
/// they are REMOVED rather than empty-stated. The balance below is server-truth
/// from `GET /payer/credits` via the shared [CreditsCubit].
///
/// JUL31 kit: a deep-blue identity header (blue-dominant structure) sits over a
/// canvas dashboard of paper cards; haldi is rationed to the single Post-a-job
/// action.
class HomeScreen extends StatelessWidget {
  const HomeScreen({
    super.key,
    required this.session,
    required this.onPost,
    required this.onBrowse,
    required this.onOpenCredits,
    this.onOpenReferral,
  });

  final AppSession session;
  final VoidCallback onPost;
  final VoidCallback onBrowse;
  final VoidCallback onOpenCredits;

  /// Opens the agency supply hub (Refer & earn). Non-null ONLY for an agency
  /// session — the Home agency section renders only when this is wired.
  final VoidCallback? onOpenReferral;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _Header(acct: session.account, role: session.role),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s5,
              AppSpacing.gutter,
              AppSpacing.s6,
            ),
            children: <Widget>[
              _SectionLabel('OVERVIEW'),
              const SizedBox(height: AppSpacing.s2),
              _CreditBalanceCard(onOpenCredits: onOpenCredits),
              const SizedBox(height: AppSpacing.s5),
              _SectionLabel('QUICK ACTIONS'),
              const SizedBox(height: AppSpacing.s2),
              Row(
                children: <Widget>[
                  Expanded(
                    // The ONE haldi CTA on Home.
                    child: BbButton(
                      label: 'Post a job',
                      iconLeft: Icons.add_circle_outline,
                      onPressed: onPost,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.s3),
                  Expanded(
                    child: BbButton(
                      label: 'Browse',
                      variant: BbButtonVariant.secondary,
                      iconLeft: Icons.search,
                      onPressed: onBrowse,
                    ),
                  ),
                ],
              ),
              // Agency-only supply hub — makes the agency dashboard distinct and
              // surfaces the agent-gated Refer-&-earn (funnel + referred workers
              // + bulk invites) that a company session never sees. Renders only
              // for an agency session (onOpenReferral is null for a company).
              if (session.role.isAgency && onOpenReferral != null) ...<Widget>[
                const SizedBox(height: AppSpacing.s5),
                _SectionLabel('AGENCY'),
                const SizedBox(height: AppSpacing.s2),
                _AgencyHubCard(onTap: onOpenReferral!),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// A tracked eyebrow that heads a dashboard section (kit label voice).
class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: AppTypography.eyebrow(color: AppColors.textMuted));
}

/// The deep-blue identity band — org name + plan over the account avatar. Blue
/// carries the structure; the haldi-tinted avatar is the one brand pop.
class _Header extends StatelessWidget {
  const _Header({required this.acct, required this.role});

  final PayerAccount acct;
  final PayerRole role;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: AppColors.blue,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s5,
        AppSpacing.gutter,
        AppSpacing.s5,
      ),
      child: Row(
        children: <Widget>[
          BbAvatar(initials: acct.initials, size: 48),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  acct.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.display(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w700,
                    color: AppColors.onBlue,
                  ),
                ),
                Text(
                  acct.plan,
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.onBlueMuted,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          // The unmissable role cue — COMPANY vs AGENCY — so the payer always
          // knows which portal they are in.
          PayerRoleBadge(role: role, onDark: true),
        ],
      ),
    );
  }
}

/// The agency Home entry into the supply hub (Refer & earn → funnel · referred
/// workers · bulk invites). Mirrors the referral screen's nav-card so the agent
/// sees a familiar affordance; deep blue is structure, never haldi.
class _AgencyHubCard extends StatelessWidget {
  const _AgencyHubCard({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      onTap: onTap,
      child: Row(
        children: <Widget>[
          const Icon(Icons.campaign_outlined, size: 24, color: AppColors.blue),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'Refer & earn',
                  style: AppTypography.display(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'Your invite link, referral funnel and referred workers.',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          const Icon(Icons.chevron_right, size: 20, color: AppColors.textFaint),
        ],
      ),
    );
  }
}

/// The one real figure on Home: the server-truth credit balance. Renders "—"
/// until the first load resolves (and if it fails) — never a fabricated 0.
class _CreditBalanceCard extends StatelessWidget {
  const _CreditBalanceCard({required this.onOpenCredits});

  final VoidCallback onOpenCredits;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CreditsCubit, CreditsState>(
      bloc: locator<CreditsCubit>(),
      builder: (BuildContext context, CreditsState credits) {
        return BbStat(
          label: 'Credit balance',
          // A failed refresh renders an honest '—', never a fabricated 0
          // (#189 fast-follow); the retry affordance re-loads server truth.
          value: credits.error ? '—' : '${credits.balance ?? '—'}',
          icon: Icons.lock_open,
          deltaText: credits.error ? 'Retry' : 'View ledger',
          onDeltaTap: credits.error
              ? () => locator<CreditsCubit>().load()
              : onOpenCredits,
        );
      },
    );
  }
}
