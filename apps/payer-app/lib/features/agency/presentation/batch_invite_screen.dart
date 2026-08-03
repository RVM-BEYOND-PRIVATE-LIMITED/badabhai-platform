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
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/batch_invite_cubit.dart';
import '../util/invite_url.dart';

/// Batch invites — mint a run of agency invite codes
/// (`POST /payer/agency/invites/batch`, AGENT-only), then print/share them. Each
/// minted code renders as a scannable QR of its ABSOLUTE share URL plus a
/// copyable link, so an agent can print a sheet and hand it out at a job site.
///
/// Faceless by construction: the only inputs are a count (1..50) and an optional
/// non-PII campaign tag. Reachable only from the agency Refer-&-earn surface (the
/// route 403s for a company session).
class BatchInviteScreen extends StatelessWidget {
  const BatchInviteScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<BatchInviteCubit>(
      create: (_) => locator<BatchInviteCubit>(),
      child: const _BatchInviteView(),
    );
  }
}

class _BatchInviteView extends StatefulWidget {
  const _BatchInviteView();

  @override
  State<_BatchInviteView> createState() => _BatchInviteViewState();
}

class _BatchInviteViewState extends State<_BatchInviteView> {
  final TextEditingController _count = TextEditingController(text: '10');
  final TextEditingController _campaign = TextEditingController();

  @override
  void dispose() {
    _count.dispose();
    _campaign.dispose();
    super.dispose();
  }

  int? get _parsedCount => int.tryParse(_count.text.trim());

  bool get _countValid {
    final int? n = _parsedCount;
    return n != null &&
        n >= BatchInviteCubit.minCount &&
        n <= BatchInviteCubit.maxCount;
  }

  void _submit() {
    final int? n = _parsedCount;
    if (n == null || !_countValid) return;
    FocusScope.of(context).unfocus();
    context.read<BatchInviteCubit>().mint(
          count: n,
          campaign: _campaign.text,
        );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _Header(onBack: () => Navigator.of(context).pop()),
            Expanded(
              child: BlocBuilder<BatchInviteCubit, BatchInviteState>(
                builder: (BuildContext context, BatchInviteState state) {
                  return ListView(
                    keyboardDismissBehavior:
                        ScrollViewKeyboardDismissBehavior.onDrag,
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.gutter,
                      AppSpacing.s2,
                      AppSpacing.gutter,
                      AppSpacing.s8,
                    ),
                    children: <Widget>[
                      Text(
                        'Create a run of invite codes to print or forward. Each '
                        'one is a QR a worker can scan to join under you.',
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.textSecondary,
                          height: 1.45,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.s4),
                      _Form(
                        countController: _count,
                        campaignController: _campaign,
                        submitting: state.isSubmitting,
                        onSubmit: _submit,
                      ),
                      const SizedBox(height: AppSpacing.s4),
                      _StatusBanner(state: state),
                      if (state.invites.isNotEmpty) ...<Widget>[
                        const SizedBox(height: AppSpacing.s5),
                        _ResultsHeader(invites: state.invites),
                        const SizedBox(height: AppSpacing.s3),
                        ...state.invites.map(
                          (MintedInvite inv) => Padding(
                            padding:
                                const EdgeInsets.only(bottom: AppSpacing.s3),
                            child: _InviteCard(invite: inv),
                          ),
                        ),
                      ],
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Form extends StatelessWidget {
  const _Form({
    required this.countController,
    required this.campaignController,
    required this.submitting,
    required this.onSubmit,
  });

  final TextEditingController countController;
  final TextEditingController campaignController;
  final bool submitting;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          BbField(
            label: 'How many invites?',
            controller: countController,
            hint: '1–50',
            mono: true,
            keyboardType: TextInputType.number,
          ),
          // BbField has no onChanged, so the count-dependent chrome (helper +
          // enabled state) tracks the controller directly for live feedback.
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: countController,
            builder: (BuildContext context, TextEditingValue value, _) {
              final String text = value.text.trim();
              final bool showError = text.isNotEmpty && !_isCountValid(text);
              return Padding(
                padding: const EdgeInsets.only(top: AppSpacing.s1),
                child: Text(
                  showError
                      ? 'Enter a number from 1 to 50.'
                      : 'Between 1 and 50 at a time.',
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color:
                        showError ? AppColors.danger : AppColors.textMuted,
                  ),
                ),
              );
            },
          ),
          const SizedBox(height: AppSpacing.s4),
          BbField(
            label: 'Campaign tag (optional)',
            controller: campaignController,
            hint: 'e.g. pune-drive-aug',
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'A short label to group this batch. No worker details here.',
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: countController,
            builder: (BuildContext context, TextEditingValue value, _) {
              final bool valid = _isCountValid(value.text.trim());
              return BbButton(
                label: submitting ? 'Creating…' : 'Create invites',
                iconLeft: Icons.qr_code_2,
                block: true,
                loading: submitting,
                onPressed: valid && !submitting ? onSubmit : null,
              );
            },
          ),
        ],
      ),
    );
  }
}

/// A count is mintable only in the server's 1..50 band.
bool _isCountValid(String text) {
  final int? n = int.tryParse(text);
  return n != null &&
      n >= BatchInviteCubit.minCount &&
      n <= BatchInviteCubit.maxCount;
}

/// The non-result feedback surface: the neutral retryable 429, the agent-only
/// 403, or the generic error. All keep any already-minted codes visible below.
class _StatusBanner extends StatelessWidget {
  const _StatusBanner({required this.state});

  final BatchInviteState state;

  @override
  Widget build(BuildContext context) {
    switch (state.status) {
      case BatchInviteStatus.rateLimited:
        return _Banner(
          icon: Icons.hourglass_empty,
          tint: AppColors.warningTint,
          iconColor: AppColors.warning,
          title: 'Just a moment',
          message:
              'You have minted a lot of invites quickly. Wait a bit, then try '
              'again — nothing was lost.',
          actionLabel: 'Try again',
          onAction: () => context.read<BatchInviteCubit>().retry(),
        );
      case BatchInviteStatus.forbidden:
        return const _Banner(
          icon: Icons.lock_outline,
          tint: AppColors.surfaceSunken,
          iconColor: AppColors.textMuted,
          title: 'Agency accounts only',
          message: 'Minting invites is only available on agency (recruiter) '
              'accounts.',
        );
      case BatchInviteStatus.error:
        return _Banner(
          icon: Icons.wifi_off,
          tint: AppColors.dangerTint,
          iconColor: AppColors.danger,
          title: 'Could not create invites',
          message: 'Please check your connection and try again.',
          actionLabel: 'Retry',
          onAction: () => context.read<BatchInviteCubit>().retry(),
        );
      case BatchInviteStatus.idle:
      case BatchInviteStatus.submitting:
      case BatchInviteStatus.ready:
        return const SizedBox.shrink();
    }
  }
}

class _Banner extends StatelessWidget {
  const _Banner({
    required this.icon,
    required this.tint,
    required this.iconColor,
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final Color tint;
  final Color iconColor;
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s4),
      decoration: BoxDecoration(
        color: tint,
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(icon, size: 22, color: iconColor),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      title,
                      style: AppTypography.display(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      message,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.textSecondary,
                        height: 1.45,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (actionLabel != null && onAction != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            BbButton(
              label: actionLabel!,
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.md,
              onPressed: onAction,
            ),
          ],
        ],
      ),
    );
  }
}

class _ResultsHeader extends StatelessWidget {
  const _ResultsHeader({required this.invites});

  final List<MintedInvite> invites;

  Future<void> _copyAll(BuildContext context) async {
    final String all = invites
        .map((MintedInvite i) => absoluteInviteUrl(i.link))
        .where((String s) => s.isNotEmpty)
        .join('\n');
    if (all.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: all));
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'All links copied',
      message: '${invites.length} invite links are on your clipboard.',
    );
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            'Ready to share (${invites.length})',
            style: AppTypography.display(
              size: AppTypography.sizeBase,
              weight: FontWeight.w700,
            ),
          ),
        ),
        BbButton(
          label: 'Copy all',
          variant: BbButtonVariant.ghost,
          size: BbButtonSize.sm,
          iconLeft: Icons.copy_all,
          onPressed: () => _copyAll(context),
        ),
      ],
    );
  }
}

/// One minted code, print-friendly: a QR of the absolute share URL, the code in
/// mono, the link, and a copy action.
class _InviteCard extends StatelessWidget {
  const _InviteCard({required this.invite});

  final MintedInvite invite;

  Future<void> _copy(BuildContext context, String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'Link copied',
      message: 'Share ${invite.code} on WhatsApp with a worker you trust.',
    );
  }

  @override
  Widget build(BuildContext context) {
    final String url = absoluteInviteUrl(invite.link);
    return BbCard(
      child: Column(
        children: <Widget>[
          Container(
            padding: const EdgeInsets.all(AppSpacing.s3),
            decoration: BoxDecoration(
              color: AppColors.surfaceCard,
              borderRadius: BorderRadius.circular(AppRadii.md),
              border: Border.all(color: AppColors.borderSubtle),
            ),
            child: QrImageView(
              data: url.isNotEmpty ? url : invite.code,
              size: 148,
              backgroundColor: AppColors.surfaceCard,
              semanticsLabel: 'Invite QR for ${invite.code}',
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          Text(
            invite.code,
            textAlign: TextAlign.center,
            style: AppTypography.mono(
              size: AppTypography.sizeMd,
              weight: FontWeight.w700,
            ),
          ),
          if (url.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.s1),
            SelectableText(
              url,
              textAlign: TextAlign.center,
              style: AppTypography.body(
                size: AppTypography.sizeXs,
                color: AppColors.textMuted,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: 'Copy link',
            variant: BbButtonVariant.secondary,
            size: BbButtonSize.md,
            iconLeft: Icons.copy,
            block: true,
            onPressed: url.isEmpty ? null : () => _copy(context, url),
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          BbIconButton(
            icon: Icons.arrow_back,
            semanticLabel: 'Back',
            onPressed: onBack,
          ),
          const SizedBox(width: AppSpacing.s3),
          Text(
            'Invite in bulk',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}
