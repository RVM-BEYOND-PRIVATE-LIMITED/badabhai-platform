import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_button.dart';
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
          //
          // #381 — go, NOT push. Pushing left the ACCEPTED consent screen alive
          // underneath, so system back walked the worker straight back onto a
          // consent they had already given — and re-accepting fires a second
          // `consent.accepted` onto the event-first audit spine (§1), which is
          // the record of WHEN consent was granted. Replacing the route is also
          // the honest model: consent is a gate you pass through once, not a
          // page you browse.
          context.go(Routes.name);
        }
      },
      builder: (BuildContext context, ConsentState state) {
        final ConsentCubit cubit = context.read<ConsentCubit>();
        // Kit auth chrome: blue header carries the title; the body holds the
        // trust mark + processing description + the 'I agree' row; the haldi CTA
        // is pinned to the bottom (kit sticky-primary pattern). No back button —
        // consent is a gate you pass through once (#381), not a page to browse.
        return Scaffold(
          bottomNavigationBar: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                AppSpacing.s2,
                AppSpacing.gutter,
                AppSpacing.s4,
              ),
              child: BbButton(
                label: state.isSubmitting ? 'Saving…' : 'Continue',
                block: true,
                loading: state.isSubmitting,
                iconRight: Icons.arrow_forward_rounded,
                onPressed: state.canSubmit ? cubit.submit : null,
              ),
            ),
          ),
          body: Column(
            children: <Widget>[
              const BbBlueHeader(title: 'Your privacy'),
              Expanded(
                child: SafeArea(
                  top: false,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.gutter,
                      AppSpacing.s6,
                      AppSpacing.gutter,
                      AppSpacing.s6,
                    ),
                    children: <Widget>[
                      Container(
                        width: 56,
                        height: 56,
                        decoration: BoxDecoration(
                          // Blue = trust/structure (design law §2). Green is
                          // reserved for success / money / WhatsApp, so the
                          // privacy mark leads with the trust colour, not green.
                          color: AppColors.infoTint,
                          borderRadius: BorderRadius.circular(AppRadii.md),
                        ),
                        child: const Icon(Icons.verified_user_outlined,
                            color: AppColors.blue, size: 30),
                      ),
                      const SizedBox(height: AppSpacing.s4),
                      // The consent statement + the tick live on ONE paper card
                      // separated by a hairline border (kit: paper card, 1px
                      // border, elevation 0 — shadows are banned, design law §4).
                      Container(
                        decoration: BoxDecoration(
                          color: AppColors.surfaceCard,
                          borderRadius: BorderRadius.circular(AppRadii.sm),
                          border: Border.all(color: AppColors.borderSubtle),
                        ),
                        padding: const EdgeInsets.all(AppSpacing.s4),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              // NOTE: this is the product description of the
                              // processing, not the DPDP notice. The full DPDP
                              // consent notice is owner/legal copy and is still
                              // outstanding — do not invent it here.
                              'We use your answers only to build your work profile and resume.',
                              style: AppTypography.body(
                                size: AppTypography.sizeMd,
                                color: AppColors.textSecondary,
                              ),
                            ),
                            const SizedBox(height: AppSpacing.s4),
                            const Divider(height: 1),
                            const SizedBox(height: AppSpacing.s2),
                            InkWell(
                              onTap: () =>
                                  cubit.setAccepted(!state.accepted),
                              borderRadius: BorderRadius.circular(AppRadii.md),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                    vertical: AppSpacing.s1),
                                child: Row(
                                  children: <Widget>[
                                    Checkbox(
                                      value: state.accepted,
                                      onChanged: (bool? v) =>
                                          cubit.setAccepted(v ?? false),
                                    ),
                                    const SizedBox(width: AppSpacing.s2),
                                    Text('I agree',
                                        style: AppTypography.body(
                                            size: AppTypography.sizeMd)),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      // Honest failure text — the cubit surfaces a real reason on
                      // ConsentStatus.failure; say what happened, in red, instead
                      // of a silently un-pressed button (design law: errors say
                      // what happened; never apologise).
                      if (state.status == ConsentStatus.failure &&
                          state.message != null) ...<Widget>[
                        const SizedBox(height: AppSpacing.s3),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            const Icon(Icons.error_outline_rounded,
                                size: 18, color: AppColors.danger),
                            const SizedBox(width: AppSpacing.s2),
                            Expanded(
                              child: Text(
                                state.message!,
                                style: AppTypography.body(
                                  size: AppTypography.sizeSm,
                                  color: AppColors.danger,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
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
