import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/kit/kit_docked_bar.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../router.dart';
import 'cubit/employer_sharing_prompt_cubit.dart';
import 'widgets/consent_notice_parts.dart';
import 'widgets/employer_sharing_notice.dart';
import 'widgets/privacy_chrome.dart';

/// The employer-sharing prompt: the approved notice, full screen, with
/// 'Haan, dikhayein' / 'Abhi nahi'.
///
/// Two arrivals, one behaviour: the home shell opens it ONCE for an existing
/// worker whose consent predates the notice, and the Settings switch pushes it
/// to turn employer contact back ON (the worker must see the notice before
/// granting). Pops `true` only after the server accepted the grant; `false`
/// for 'Abhi nahi' or back.
class EmployerSharingPromptScreen extends StatelessWidget {
  const EmployerSharingPromptScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<EmployerSharingPromptCubit>(
      create: (_) => locator<EmployerSharingPromptCubit>(),
      child: const _PromptView(),
    );
  }
}

class _PromptView extends StatelessWidget {
  const _PromptView();

  /// Pops with [result]; a stack with nothing under the prompt (restored after
  /// a re-lock) lands on the home shell instead of a dead end.
  void _close(BuildContext context, bool result) {
    if (context.canPop()) {
      context.pop(result);
    } else {
      context.go(Routes.resume);
    }
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<EmployerSharingPromptCubit, EmployerSharingPromptState>(
      listenWhen: (EmployerSharingPromptState prev,
              EmployerSharingPromptState curr) =>
          prev.status != curr.status,
      listener: (BuildContext context, EmployerSharingPromptState state) {
        switch (state.status) {
          case EmployerSharingPromptStatus.granted:
            _close(context, true);
          case EmployerSharingPromptStatus.dismissed:
            _close(context, false);
          case EmployerSharingPromptStatus.idle:
          case EmployerSharingPromptStatus.submitting:
          case EmployerSharingPromptStatus.failed:
            break;
        }
      },
      builder: (BuildContext context, EmployerSharingPromptState state) {
        final EmployerSharingPromptCubit cubit =
            context.read<EmployerSharingPromptCubit>();
        return PopScope(
          // System back is a "not now", never a grant — and never mid-grant.
          canPop: false,
          onPopInvokedWithResult: (bool didPop, Object? _) {
            if (!didPop) cubit.dismiss();
          },
          child: Scaffold(
            backgroundColor: OnboardingColors.canvasBg,
            body: Column(
              children: <Widget>[
                const PrivacyTopBar(),
                Expanded(
                  child: SafeArea(
                    top: false,
                    bottom: false,
                    child: OnboardingBody(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          const PrivacyShieldDisc(),
                          const SizedBox(height: 12),
                          const EmployerSharingNotice(),
                          if (state.status ==
                              EmployerSharingPromptStatus.failed) ...<Widget>[
                            const SizedBox(height: 12),
                            ConsentErrorLine(
                              failureReason(state.failure).reason,
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
                KitDockedBar(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      PrimaryActionButton(
                        label: 'Haan, dikhayein',
                        showArrow: false,
                        isLoading: state.isSubmitting,
                        onPressed: state.canAct ? cubit.grant : null,
                      ),
                      const SizedBox(height: 8),
                      BbButton(
                        label: 'Abhi nahi',
                        variant: BbButtonVariant.ghost,
                        size: BbButtonSize.md,
                        block: true,
                        onPressed: state.canAct ? cubit.dismiss : null,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
