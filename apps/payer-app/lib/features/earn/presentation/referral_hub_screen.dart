import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/referral_cubit.dart';
import 'widgets/earn_header.dart';

/// Referral hub — a festive card with the agency's QR (rendered client-side
/// from the link), the mono link, a "Copy & share link" CTA, and the 3-step
/// "how earning works" explainer. The link is the one supply surface with a
/// real backend later (`POST /payer/agency/invites`).
class ReferralHubScreen extends StatelessWidget {
  const ReferralHubScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ReferralCubit>(
      create: (_) => locator<ReferralCubit>()..load(),
      child: _ReferralView(onBack: onBack),
    );
  }
}

class _ReferralView extends StatelessWidget {
  const _ReferralView({required this.onBack});

  final VoidCallback onBack;

  Future<void> _copy(BuildContext context, String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'Link copied',
      message: 'Share it on WhatsApp to start earning.',
    );
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ReferralCubit, ReferralState>(
      builder: (BuildContext context, ReferralState state) {
        if (state.status == ReferralLoadStatus.loading ||
            state.status == ReferralLoadStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == ReferralLoadStatus.error || state.link == null) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load your link',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<ReferralCubit>().load(),
            ),
          );
        }

        final ReferralLink link = state.link!;

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            EarnHeader(title: 'Referral hub', onBack: onBack),
            const SizedBox(height: AppSpacing.s4),
            BbCard(
              festive: true,
              padding: const EdgeInsets.all(AppSpacing.s5),
              child: Column(
                children: <Widget>[
                  Container(
                    width: 160,
                    height: 160,
                    padding: const EdgeInsets.all(AppSpacing.s3),
                    decoration: BoxDecoration(
                      color: AppColors.paper0,
                      borderRadius: BorderRadius.circular(AppRadii.md),
                      border: Border.all(color: AppColors.borderDefault),
                    ),
                    child: QrImageView(
                      data: link.url,
                      version: QrVersions.auto,
                      gapless: true,
                      backgroundColor: AppColors.paper0,
                      eyeStyle: const QrEyeStyle(
                        eyeShape: QrEyeShape.square,
                        color: AppColors.ink900,
                      ),
                      dataModuleStyle: const QrDataModuleStyle(
                        dataModuleShape: QrDataModuleShape.square,
                        color: AppColors.ink900,
                      ),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.s3,
                      vertical: AppSpacing.s3,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceSunken,
                      borderRadius: BorderRadius.circular(AppRadii.sm),
                    ),
                    child: Text(
                      link.url,
                      textAlign: TextAlign.center,
                      style: AppTypography.mono(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w600,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s3),
                  BbButton(
                    label: 'Copy & share link',
                    iconLeft: Icons.copy,
                    block: true,
                    onPressed: () => _copy(context, link.url),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.s5),
            Text(
              'How earning works',
              style: AppTypography.display(
                size: AppTypography.sizeBase,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            const _Step(
              number: '1',
              accent: AppColors.brand,
              leadIn: 'Introduce a worker',
              body: ' — share your link. First-to-introduce by phone wins '
                  'attribution.',
            ),
            const SizedBox(height: AppSpacing.s3),
            const _Step(
              number: '2',
              accent: AppColors.brand,
              leadIn: 'They get profiled',
              body: ' by bada bhai and become a live candidate.',
            ),
            const SizedBox(height: AppSpacing.s3),
            const _Step(
              number: '3',
              accent: AppColors.success,
              leadIn: 'Anyone unlocks them within 90 days',
              body: ' → you earn 25% of that unlock.',
            ),
            // The REAL aggregate funnel (below the explainer so the primary link
            // CTA + how-it-works stay above the fold). Hidden when the summary
            // fetch failed.
            if (state.summary != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s5),
              _FunnelCard(summary: state.summary!),
            ],
          ],
        );
      },
    );
  }
}

/// One numbered step of the "how earning works" list — a mono number disc + a
/// bold lead-in over muted body copy.
class _Step extends StatelessWidget {
  const _Step({
    required this.number,
    required this.accent,
    required this.leadIn,
    required this.body,
  });

  final String number;
  final Color accent;
  final String leadIn;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
          child: Text(
            number,
            style: AppTypography.mono(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.textOnBrand,
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: RichText(
            text: TextSpan(
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
                height: 1.45,
              ),
              children: <InlineSpan>[
                TextSpan(
                  text: leadIn,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w700,
                    color: AppColors.textPrimary,
                    height: 1.45,
                  ),
                ),
                TextSpan(text: body),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// The referral FUNNEL — the real aggregate counts from
/// `GET /payer/agency/referrals/summary` (Introduced · Clicked · Accepted). The
/// counts are aggregate-only (there is NO per-worker breakdown on this seam),
/// and a k-anonymity floor is applied server-side, so a `0` may mean "below the
/// floor of N" rather than literally none — the caption says so honestly.
class _FunnelCard extends StatelessWidget {
  const _FunnelCard({required this.summary});

  final ReferralsSummary summary;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Your referral funnel',
            style: AppTypography.display(
              size: AppTypography.sizeBase,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              _stat(summary.created, 'Introduced'),
              const SizedBox(width: AppSpacing.s4),
              _stat(summary.clicked, 'Clicked'),
              const SizedBox(width: AppSpacing.s4),
              _stat(summary.accepted, 'Accepted'),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Aggregate only. A 0 can mean "below the ${summary.minBucket} floor" '
            '— we never show a single worker here.',
            style: AppTypography.body(
              size: AppTypography.size2xs,
              color: AppColors.textMuted,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }

  Widget _stat(int value, String label) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(
          '$value',
          style: AppTypography.mono(
            size: AppTypography.sizeXl,
            weight: FontWeight.w700,
            color: AppColors.ink900,
          ),
        ),
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.size2xs,
            color: AppColors.textMuted,
          ),
        ),
      ],
    );
  }
}
