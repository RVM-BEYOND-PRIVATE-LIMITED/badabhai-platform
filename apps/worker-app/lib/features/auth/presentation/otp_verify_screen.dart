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
import 'cubit/otp_verify_cubit.dart';

class OtpVerifyScreen extends StatelessWidget {
  const OtpVerifyScreen({super.key, this.phone});

  /// The phone the OTP was sent to (passed as go_router `extra` from login).
  final String? phone;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<OtpVerifyCubit>(
      create: (_) => locator<OtpVerifyCubit>(),
      child: _OtpVerifyView(phone: phone ?? ''),
    );
  }
}

class _OtpVerifyView extends StatefulWidget {
  const _OtpVerifyView({required this.phone});

  final String phone;

  @override
  State<_OtpVerifyView> createState() => _OtpVerifyViewState();
}

class _OtpVerifyViewState extends State<_OtpVerifyView> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String phone = widget.phone;
    return BlocConsumer<OtpVerifyCubit, OtpVerifyState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, OtpVerifyState state) {
        if (state.status == OtpVerifyStatus.success) {
          // Route off the resolved next-step (exhaustive — all three arms):
          switch (state.next!) {
            case OtpNext.onboarding:
              // Route into the consent onboarding (consent → name → chat →
              // profile → resume). Reached with the gate OFF (real/default build:
              // no PIN, inert redirect) AND for a gate-ON returning worker who
              // never consented. Use `go` (not push) so it is IDEMPOTENT with the
              // gate-ON router redirect, which also forces /consent on the status
              // flip — otherwise a second /consent would stack on top.
              context.go(Routes.consent);
            case OtpNext.setPin:
              // New user (gate ON) → choose a PIN before the shell.
              context.go(Routes.setPin);
            case OtpNext.authenticated:
              // Returning worker with a PIN (gate ON) → straight to the shell
              // (no re-profiling). The redirect blocks onboarding routes anyway.
              context.go(Routes.resume);
          }
        } else if (state.status == OtpVerifyStatus.failure) {
          // Surface the verify failure instead of silently reverting the button.
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(
              SnackBar(
                backgroundColor: AppColors.danger,
                content: Text(
                  state.message ?? 'Could not verify the code. Please try again.',
                ),
              ),
            );
        }
      },
      builder: (BuildContext context, OtpVerifyState state) {
        return BbScaffold(
          appBar: const BbAppBar(title: 'Verify OTP'),
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: AppSpacing.s7),
              Text('Enter the code',
                  style: AppTypography.display(size: AppTypography.sizeXl)),
              const SizedBox(height: AppSpacing.s2),
              Text(
                'Sent to $phone (mock — any 4-6 digits)',
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.s6),
              TextField(
                controller: _controller,
                keyboardType: TextInputType.number,
                textAlign: TextAlign.center,
                style: AppTypography.mono(
                  size: AppTypography.size2xl,
                  weight: FontWeight.w700,
                  letterSpacing: 12,
                ),
                decoration: const InputDecoration(hintText: '— — — —'),
              ),
              const SizedBox(height: AppSpacing.s7),
              BbButton(
                label: state.isSubmitting ? 'Verifying…' : 'Verify',
                block: true,
                loading: state.isSubmitting,
                onPressed: state.isSubmitting
                    ? null
                    : () => context.read<OtpVerifyCubit>().verify(
                          phone: phone,
                          otp: _controller.text.trim(),
                        ),
              ),
            ],
          ),
        );
      },
    );
  }
}
