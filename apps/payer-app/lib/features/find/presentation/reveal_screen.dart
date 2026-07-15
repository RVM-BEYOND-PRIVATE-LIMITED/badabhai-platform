import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/name_mask.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/reveal_cubit.dart';
import 'reveal_args.dart';

/// Revealed profile. Two shapes behind one screen (see [RevealArgs]):
///
///  - MOCK — the kit's rich reveal: real name + phone (mono pill), skills, and a
///    resume download row. Only reachable after a paid mock unlock.
///  - REAL — the faceless applicant + the in-app RELAY handle from
///    `POST /payer/unlocks/:id/reveal` and a MASKED résumé disclosure. The
///    backend returns NO name/phone, so none is ever fabricated here.
class RevealScreen extends StatelessWidget {
  const RevealScreen({
    super.key,
    required this.args,
    required this.onBack,
  });

  final RevealArgs args;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    if (args.isReal) {
      return BlocProvider<RevealCubit>(
        create: (_) => locator<RevealCubit>()..load(args.unlockId!),
        child: _RealReveal(args: args, onBack: onBack),
      );
    }
    return _MockReveal(candidate: args.candidate!, onBack: onBack);
  }
}

// ===========================================================================
// REAL — relay handle + masked résumé (no fabricated name/phone)
// ===========================================================================

class _RealReveal extends StatelessWidget {
  const _RealReveal({required this.args, required this.onBack});

  final RevealArgs args;
  final VoidCallback onBack;

  Future<void> _contactViaRelay(BuildContext context, String handle) async {
    await Clipboard.setData(ClipboardData(text: handle));
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'Relay handle copied',
      message: 'Reach this candidate through the in-app relay.',
    );
  }

  Future<void> _downloadResume(BuildContext context) async {
    final RevealCubit cubit = context.read<RevealCubit>();
    final DisclosureResult result = await cubit.discloseResume(
      workerId: args.applicant!.workerId,
      jobPostingId: args.jobId,
    );
    if (!context.mounted) return;
    // A 429 is the per-payer disclosure cap (XB-G, a harvest-velocity limiter)
    // — NON-retry copy on purpose (review F3): "try again" would invite
    // hammering the limiter. No retry affordance, no refresh icon.
    if (cubit.state.disclosure == DisclosureStatus.limited) {
      showBbToast(
        context,
        title: 'Limit reached for now',
        message: 'Résumé limit reached for now — try again later.',
        icon: Icons.hourglass_bottom,
      );
      return;
    }
    // An OUTAGE (non-2xx/transport) is retryable — distinct from the neutral
    // deny below, whose copy is reserved for the genuine 200 {unavailable}.
    if (cubit.state.disclosure == DisclosureStatus.error) {
      showBbToast(
        context,
        title: 'Something went wrong',
        message: 'Could not fetch the résumé — try again.',
        icon: Icons.refresh,
      );
      return;
    }
    if (!result.disclosed) {
      showBbToast(
        context,
        title: 'Résumé unavailable',
        message: 'This masked résumé is not available right now.',
        icon: Icons.info_outline,
      );
      return;
    }
    await Clipboard.setData(ClipboardData(text: result.resumeUrl!));
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'Masked résumé ready',
      message: 'Secure PDF link copied to clipboard.',
    );
  }

  @override
  Widget build(BuildContext context) {
    final Applicant applicant = args.applicant!;
    return BlocBuilder<RevealCubit, RevealState>(
      builder: (BuildContext context, RevealState state) {
        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            _header(),
            const SizedBox(height: AppSpacing.s4),
            _identityCard(applicant),
            const SizedBox(height: AppSpacing.s4),
            _relayCard(context, state),
            const SizedBox(height: AppSpacing.s4),
            _resumeRow(context, state),
          ],
        );
      },
    );
  }

  Widget _header() {
    return Row(
      children: <Widget>[
        BbIconButton(
          icon: Icons.arrow_back,
          semanticLabel: 'Back',
          onPressed: onBack,
        ),
        const SizedBox(width: AppSpacing.s3),
        Text(
          'Candidate',
          style: AppTypography.display(
            size: AppTypography.sizeLg,
            weight: FontWeight.w800,
          ),
        ),
        const Spacer(),
        const BbBadge('Unlocked', tone: BbBadgeTone.success, icon: Icons.lock_open),
      ],
    );
  }

  Widget _identityCard(Applicant applicant) {
    final List<String> facets = <String>[
      if ((applicant.tradeLabel ?? '').isNotEmpty) applicant.tradeLabel!,
      if ((applicant.experienceBand ?? '').isNotEmpty) applicant.experienceBand!,
      if ((applicant.cityLabel ?? '').isNotEmpty) applicant.cityLabel!,
    ];
    return BbCard(
      festive: true,
      padding: const EdgeInsets.all(AppSpacing.s6),
      child: Column(
        children: <Widget>[
          const BbAvatar(
            initials: '••',
            size: 84,
            mode: BbAvatarMode.masked,
            sealed: true,
          ),
          const SizedBox(height: AppSpacing.s3),
          Text(
            applicant.maskedLabel,
            textAlign: TextAlign.center,
            style: AppTypography.mono(
              size: AppTypography.sizeXl,
              weight: FontWeight.w800,
            ),
          ),
          if (facets.isNotEmpty) ...<Widget>[
            const SizedBox(height: 2),
            Text(
              facets.join(' · '),
              textAlign: TextAlign.center,
              style: AppTypography.body(
                size: AppTypography.sizeBase,
                weight: FontWeight.w600,
                color: AppColors.textSecondary,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Identity stays masked — reach this candidate through the '
            'in-app relay below.',
            textAlign: TextAlign.center,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }

  Widget _relayCard(BuildContext context, RevealState state) {
    if (state.status == RevealStatus.loading ||
        state.status == RevealStatus.initial) {
      return const BbCard(
        padding: EdgeInsets.all(AppSpacing.s6),
        child: Center(child: BbStatusView.loading()),
      );
    }
    if (state.status == RevealStatus.unavailable ||
        state.status == RevealStatus.error) {
      return BbCard(
        child: Row(
          children: <Widget>[
            const Icon(Icons.info_outline, color: AppColors.textMuted),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: Text(
                'Contact relay is not available right now.',
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

    final String handle = state.relayHandle ?? '';
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionLabel('Contact relay'),
          const SizedBox(height: AppSpacing.s2),
          Row(
            children: <Widget>[
              BbBadge(state.channelLabel, tone: BbBadgeTone.neutral),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.s3,
                    vertical: AppSpacing.s2,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceSunken,
                    borderRadius: BorderRadius.circular(AppRadii.pill),
                  ),
                  child: Text(
                    handle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.mono(
                      size: AppTypography.sizeBase,
                      weight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s4),
          BbButton(
            label: 'Contact via relay',
            iconLeft: Icons.chat_bubble_outline,
            block: true,
            onPressed: () => _contactViaRelay(context, handle),
          ),
        ],
      ),
    );
  }

  Widget _resumeRow(BuildContext context, RevealState state) {
    final bool loading = state.disclosure == DisclosureStatus.loading;
    // While rate-limited (XB-G 429) the row is NOT tappable — the card itself
    // must not stay a retry affordance against the harvest-velocity limiter.
    final bool limited = state.disclosure == DisclosureStatus.limited;
    return BbCard(
      onTap: (loading || limited) ? null : () => _downloadResume(context),
      child: Row(
        children: <Widget>[
          Container(
            width: 46,
            height: 46,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AppColors.brandTint,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            child: const Icon(Icons.description,
                size: 24, color: AppColors.brandPress),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'Masked résumé',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w700,
                  ),
                ),
                Text(
                  switch (state.disclosure) {
                    DisclosureStatus.ready =>
                      'Secure PDF link copied · tap to refresh',
                    DisclosureStatus.limited =>
                      'Limit reached for now — try again later',
                    _ => 'PII redacted · generated by BadaBhai',
                  },
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          ),
          if (loading)
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            const Icon(Icons.download, size: 22, color: AppColors.textMuted),
        ],
      ),
    );
  }

  Widget _sectionLabel(String text) => Text(
        text.toUpperCase(),
        style: AppTypography.eyebrow(color: AppColors.textBrand),
      );
}

// ===========================================================================
// MOCK — the kit's rich reveal (unchanged design)
// ===========================================================================

class _MockReveal extends StatelessWidget {
  const _MockReveal({required this.candidate, required this.onBack});

  final Candidate candidate;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      children: <Widget>[
        Row(
          children: <Widget>[
            BbIconButton(
              icon: Icons.arrow_back,
              semanticLabel: 'Back',
              onPressed: onBack,
            ),
            const SizedBox(width: AppSpacing.s3),
            Text(
              'Candidate',
              style: AppTypography.display(
                size: AppTypography.sizeLg,
                weight: FontWeight.w800,
              ),
            ),
            const Spacer(),
            const BbBadge(
              'Unlocked',
              tone: BbBadgeTone.success,
              icon: Icons.lock_open,
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        BbCard(
          festive: true,
          padding: const EdgeInsets.all(AppSpacing.s6),
          child: Column(
            children: <Widget>[
              BbAvatar(
                initials: NameMask.initials(candidate.name),
                size: 84,
                sealed: true,
              ),
              const SizedBox(height: AppSpacing.s3),
              Text(
                candidate.name,
                textAlign: TextAlign.center,
                style: AppTypography.display(
                  size: AppTypography.sizeXl,
                  weight: FontWeight.w800,
                ),
              ),
              Text(
                '${candidate.trade} · ${candidate.exp}',
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w600,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: AppSpacing.s3),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.s4,
                  vertical: AppSpacing.s2,
                ),
                decoration: BoxDecoration(
                  color: AppColors.surfaceSunken,
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(Icons.phone, size: 16, color: AppColors.success),
                    const SizedBox(width: 6),
                    Text(
                      candidate.phone,
                      style: AppTypography.mono(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _sectionLabel('Skills'),
              const SizedBox(height: AppSpacing.s2),
              Wrap(
                spacing: 7,
                runSpacing: 7,
                children: <Widget>[
                  BbBadge(candidate.skill, tone: BbBadgeTone.neutral),
                  const BbBadge('Quality check', tone: BbBadgeTone.neutral),
                  const BbBadge('Shift work', tone: BbBadgeTone.neutral),
                ],
              ),
              const SizedBox(height: AppSpacing.s4),
              _sectionLabel('Location & availability'),
              const SizedBox(height: AppSpacing.s2),
              RichText(
                text: TextSpan(
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textSecondary,
                  ),
                  children: <InlineSpan>[
                    TextSpan(text: '${candidate.loc} · '),
                    TextSpan(
                      text: candidate.avail,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w600,
                        color: AppColors.success,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbCard(
          onTap: () {},
          child: Row(
            children: <Widget>[
              Container(
                width: 46,
                height: 46,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.brandTint,
                  borderRadius: BorderRadius.circular(AppRadii.md),
                ),
                child: const Icon(Icons.description,
                    size: 24, color: AppColors.brandPress),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'AI branded resume',
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      'Generated by BadaBhai · PDF',
                      style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.download, size: 22, color: AppColors.textMuted),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbButton(
          label: 'Contact on WhatsApp',
          iconLeft: Icons.chat,
          block: true,
          onPressed: () {},
        ),
      ],
    );
  }

  Widget _sectionLabel(String text) {
    return Text(
      text.toUpperCase(),
      style: AppTypography.eyebrow(color: AppColors.textBrand),
    );
  }
}
