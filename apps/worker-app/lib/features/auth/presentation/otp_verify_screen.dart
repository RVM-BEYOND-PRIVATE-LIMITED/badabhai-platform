import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

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
  const OtpVerifyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<OtpVerifyCubit>(
      create: (_) => locator<OtpVerifyCubit>(),
      child: const _OtpVerifyView(),
    );
  }
}

class _OtpVerifyView extends StatefulWidget {
  const _OtpVerifyView();

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
    final String phone =
        (ModalRoute.of(context)?.settings.arguments as String?) ?? '';
    return BlocConsumer<OtpVerifyCubit, OtpVerifyState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, OtpVerifyState state) {
        if (state.status == OtpVerifyStatus.success) {
          Navigator.pushNamed(context, Routes.consent);
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
