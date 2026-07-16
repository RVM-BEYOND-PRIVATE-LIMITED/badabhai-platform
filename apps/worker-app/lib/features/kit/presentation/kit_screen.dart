import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import 'cubit/kit_list_cubit.dart';
import '../domain/interview_kit.dart';

/// Interview-kit list (spec §5.3 / screens.jsx 231-249). Keeps the shell's
/// bottom bar (no own bottomNavigationBar) — it sits inside the PROFILE tab
/// (WA-3: it is entered from Profile, so back must land on Profile).
class KitScreen extends StatelessWidget {
  const KitScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<KitListCubit>(
      create: (_) => locator<KitListCubit>()..load(),
      child: const _KitView(),
    );
  }
}

class _KitView extends StatelessWidget {
  const _KitView();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<KitListCubit, KitListState>(
      builder: (BuildContext context, KitListState state) {
        return switch (state.status) {
          KitListStatus.loading => const Scaffold(
              appBar: BbAppBar(title: 'Interview kit'),
              body: BbStatusView.loading(),
            ),
          KitListStatus.failed => Scaffold(
              appBar: const BbAppBar(title: 'Interview kit'),
              body: BbStatusView(
                icon: failureReason(state.failure).icon,
                title: 'Kit load nahi hui.',
                subtitle: failureReason(state.failure).reason,
                action: FilledButton(
                  onPressed: () => context.read<KitListCubit>().load(),
                  child: const Text('Try again'),
                ),
              ),
            ),
          KitListStatus.ready => _list(context, state.items),
        };
      },
    );
  }

  Widget _list(BuildContext context, List<KitListItem> items) {
    return Scaffold(
      appBar: const BbAppBar(title: 'Interview kit'),
      body: ListView(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.gutter,
          vertical: AppSpacing.s4,
        ),
        children: <Widget>[
          Text(
            'Har trade ke common sawaal aur interview taiyari. '
            'Interview se pehle padhein.',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.s4),
          if (items.isEmpty)
            // Honest empty state — the list loaded but returned no kits (not a
            // fake kit, not a false "check internet").
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.s5),
              child: Text(
                'Abhi koi interview kit available nahi. Thodi der baad dekhein.',
                style: AppTypography.body(color: AppColors.textMuted),
              ),
            ),
          for (final KitListItem item in items)
            BbListRow.kit(
              icon: Icons.build_outlined,
              title: item.title,
              subtitle: item.subtitle,
              onTap: () =>
                  context.push('${Routes.kitDetail}/${item.tradeKey}'),
            ),
          // Coming-soon stub for the alpha — the per-day interview checklist
          // (documents / dress / timing) is a follow-up; tapping just nudges.
          BbListRow.kit(
            icon: Icons.assignment_outlined,
            iconBg: AppColors.successTint,
            iconColor: AppColors.success,
            title: 'Interview din ki checklist',
            subtitle: 'Documents · pehnaava · timing',
            onTap: () => ScaffoldMessenger.of(context)
              ..clearSnackBars()
              ..showSnackBar(
                const SnackBar(content: Text('Jald aa raha hai')),
              ),
          ),
        ],
      ),
    );
  }
}
