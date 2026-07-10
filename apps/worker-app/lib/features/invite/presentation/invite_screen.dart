import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../domain/invite_repository.dart';
import 'cubit/invite_cubit.dart';

/// "Dost ko invite karein" (A3). Creates a referral invite on open and shares the
/// link via the platform sheet. Warm bada-bhai voice; PII-free (only the code).
class InviteScreen extends StatelessWidget {
  const InviteScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<InviteCubit>(
      create: (_) => locator<InviteCubit>()..load(),
      child: const _InviteView(),
    );
  }
}

class _InviteView extends StatelessWidget {
  const _InviteView();

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Dost ko invite karein'),
      body: BlocBuilder<InviteCubit, InviteState>(
        builder: (BuildContext context, InviteState state) {
          return switch (state.status) {
            InviteStatus.loading => const BbStatusView.loading(),
            InviteStatus.error => BbStatusView(
                icon: failureReason(state.failure).icon,
                title: 'Invite link nahi bani.',
                subtitle: failureReason(state.failure).reason,
                action: FilledButton(
                  onPressed: () => context.read<InviteCubit>().load(),
                  child: const Text('Dobara try karein'),
                ),
              ),
            InviteStatus.ready => _ready(context, state.link!),
          };
        },
      ),
    );
  }

  Widget _ready(BuildContext context, InviteLink link) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const SizedBox(height: AppSpacing.s4),
          Container(
            width: 96,
            height: 96,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.saffron50,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.group_add_rounded,
                size: 48, color: AppColors.saffronDeep),
          ),
          const SizedBox(height: AppSpacing.s5),
          Text(
            'Apne dost ko BadaBhai par bulao',
            textAlign: TextAlign.center,
            style: AppTypography.display(
                size: AppTypography.sizeXl, weight: FontWeight.w800),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'Woh bhi apna profile banakar factory jobs pa sakte hain — no test, '
            'bas baat-cheet.',
            textAlign: TextAlign.center,
            style: AppTypography.body(color: AppColors.textMuted),
          ),
          const SizedBox(height: AppSpacing.s5),
          _linkChip(link),
          const Spacer(),
          BbButton(
            label: 'Link share karein',
            block: true,
            iconLeft: Icons.share_rounded,
            onPressed: () => context.read<InviteCubit>().shareInvite(),
          ),
          const SizedBox(height: AppSpacing.s3),
        ],
      ),
    );
  }

  Widget _linkChip(InviteLink link) {
    return Container(
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s4, vertical: AppSpacing.s3),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.link_rounded, size: 20, color: AppColors.textMuted),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              link.url,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(size: AppTypography.sizeSm),
            ),
          ),
        ],
      ),
    );
  }
}
