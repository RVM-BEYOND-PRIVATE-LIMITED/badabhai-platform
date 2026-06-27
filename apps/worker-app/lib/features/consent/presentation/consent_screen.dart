import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import 'cubit/consent_cubit.dart';

class ConsentScreen extends StatelessWidget {
  const ConsentScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ConsentCubit>(
      create: (_) => locator<ConsentCubit>(),
      child: const _ConsentView(),
    );
  }
}

class _ConsentView extends StatelessWidget {
  const _ConsentView();

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ConsentCubit, ConsentState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, ConsentState state) {
        if (state.status == ConsentStatus.success) {
          // Capture the worker's name once (consent-gated) before chat profiling.
          context.push(Routes.name);
        }
      },
      builder: (BuildContext context, ConsentState state) {
        final ConsentCubit cubit = context.read<ConsentCubit>();
        return BbScaffold(
          appBar: const BbAppBar(title: 'Consent'),
          bottomBar: BbButton(
            label: state.isSubmitting ? 'Saving…' : 'Continue',
            block: true,
            loading: state.isSubmitting,
            iconRight: Icons.arrow_forward_rounded,
            onPressed: state.canSubmit ? cubit.submit : null,
          ),
          body: ListView(
            padding: const EdgeInsets.only(top: AppSpacing.s6),
            children: <Widget>[
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: AppColors.successTint,
                  borderRadius: BorderRadius.circular(AppRadii.md),
                ),
                child: const Icon(Icons.verified_user_outlined,
                    color: AppColors.success, size: 30),
              ),
              const SizedBox(height: AppSpacing.s4),
              Text('Your privacy',
                  style: AppTypography.display(size: AppTypography.sizeXl)),
              const SizedBox(height: AppSpacing.s3),
              Text(
                'We use your answers only to build your work profile and resume. '
                '(DPDP consent copy is a Phase 1 placeholder.)',
                style: AppTypography.body(
                  size: AppTypography.sizeMd,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: AppSpacing.s5),
              InkWell(
                onTap: () => cubit.setAccepted(!state.accepted),
                borderRadius: BorderRadius.circular(AppRadii.md),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
                  child: Row(
                    children: <Widget>[
                      Checkbox(
                        value: state.accepted,
                        onChanged: (bool? v) => cubit.setAccepted(v ?? false),
                      ),
                      const SizedBox(width: AppSpacing.s2),
                      Text('I agree',
                          style: AppTypography.body(size: AppTypography.sizeMd)),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
