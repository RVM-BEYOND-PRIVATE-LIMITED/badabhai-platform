import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/kyc_cubit.dart';
import 'widgets/earn_header.dart';

/// KYC — payout verification. A teal "encrypted, payouts-only" info note over a
/// state machine: none → the PAN/bank form, review → "under review", verified →
/// a confirmation. The header badge reflects the current status.
class KycScreen extends StatelessWidget {
  const KycScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<KycCubit>(
      create: (_) => locator<KycCubit>()..load(),
      child: _KycView(onBack: onBack),
    );
  }
}

class _KycView extends StatefulWidget {
  const _KycView({required this.onBack});

  final VoidCallback onBack;

  @override
  State<_KycView> createState() => _KycViewState();
}

class _KycViewState extends State<_KycView> {
  final TextEditingController _fullName = TextEditingController();
  final TextEditingController _pan = TextEditingController();
  final TextEditingController _account = TextEditingController();
  final TextEditingController _ifsc = TextEditingController();

  @override
  void dispose() {
    _fullName.dispose();
    _pan.dispose();
    _account.dispose();
    _ifsc.dispose();
    super.dispose();
  }

  Future<void> _submit(BuildContext context) async {
    final bool ok = await context.read<KycCubit>().submit(
          KycSubmission(
            fullName: _fullName.text,
            pan: _pan.text,
            accountNumber: _account.text,
            ifsc: _ifsc.text,
          ),
        );
    if (!context.mounted || !ok) return;
    showBbToast(
      context,
      title: 'KYC submitted',
      message: 'Your PAN and bank details are under review.',
    );
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<KycCubit, KycState>(
      builder: (BuildContext context, KycState state) {
        if (state.status == KycLoadStatus.loading ||
            state.status == KycLoadStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == KycLoadStatus.error) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load KYC',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<KycCubit>().load(),
            ),
          );
        }

        final (BbBadgeTone tone, String label) = switch (state.kyc) {
          KycStatus.verified => (BbBadgeTone.success, state.kyc.badgeLabel),
          KycStatus.review => (BbBadgeTone.warning, state.kyc.badgeLabel),
          KycStatus.none => (BbBadgeTone.neutral, state.kyc.badgeLabel),
        };

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            EarnHeader(
              title: 'KYC',
              onBack: widget.onBack,
              trailing: BbBadge(label, tone: tone),
            ),
            const SizedBox(height: AppSpacing.s4),
            const _InfoNote(),
            const SizedBox(height: AppSpacing.s4),
            ...switch (state.kyc) {
              KycStatus.none => _form(context, state.submitting),
              KycStatus.review => const <Widget>[_ReviewCard()],
              KycStatus.verified => const <Widget>[_VerifiedCard()],
            },
          ],
        );
      },
    );
  }

  List<Widget> _form(BuildContext context, bool submitting) {
    return <Widget>[
      BbField(
        label: 'Full name (as on PAN)',
        controller: _fullName,
        hint: 'Apex Staffing Pvt Ltd',
      ),
      const SizedBox(height: AppSpacing.s4),
      BbField(
        label: 'PAN number',
        controller: _pan,
        hint: 'ABCDE1234F',
        mono: true,
      ),
      const SizedBox(height: AppSpacing.s4),
      BbField(
        label: 'Bank account number',
        controller: _account,
        hint: '0000 0000 0000',
        keyboardType: TextInputType.number,
        mono: true,
      ),
      const SizedBox(height: AppSpacing.s4),
      BbField(
        label: 'IFSC code',
        controller: _ifsc,
        hint: 'HDFC0001234',
        mono: true,
      ),
      const SizedBox(height: AppSpacing.s5),
      BbButton(
        label: 'Submit for verification',
        iconLeft: Icons.verified_user,
        block: true,
        loading: submitting,
        onPressed: () => _submit(context),
      ),
    ];
  }
}

/// The teal "encrypted, payouts-only" privacy note.
class _InfoNote extends StatelessWidget {
  const _InfoNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s4),
      decoration: BoxDecoration(
        color: AppColors.infoTint,
        borderRadius: BorderRadius.circular(AppRadii.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.lock, size: 22, color: AppColors.teal700),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              'Your PAN and bank details are encrypted and used only to send '
              'payouts. Required before your first withdrawal.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.teal700,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The "under review" state card.
class _ReviewCard extends StatelessWidget {
  const _ReviewCard();

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s6),
      child: Column(
        children: <Widget>[
          Container(
            width: 60,
            height: 60,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.warningTint,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.hourglass_top,
                size: 30, color: AppColors.saffronDeep),
          ),
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Under review',
            style: AppTypography.display(
              size: AppTypography.sizeMd,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            "We're verifying your details. This usually takes 1–2 working days.",
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
}

/// The "verified" confirmation card — withdrawals enabled.
class _VerifiedCard extends StatelessWidget {
  const _VerifiedCard();

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s6),
      child: Column(
        children: <Widget>[
          Container(
            width: 60,
            height: 60,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.successTint,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.verified,
                size: 30, color: AppColors.success),
          ),
          const SizedBox(height: AppSpacing.s3),
          Text(
            'KYC verified',
            style: AppTypography.display(
              size: AppTypography.sizeMd,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          Text(
            'Your payout account is verified. Withdrawals to your bank are '
            'enabled.',
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
}
