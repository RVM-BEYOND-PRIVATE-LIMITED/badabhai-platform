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
import 'cubit/phone_login_cubit.dart';

class PhoneLoginScreen extends StatelessWidget {
  const PhoneLoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<PhoneLoginCubit>(
      create: (_) => locator<PhoneLoginCubit>(),
      child: const _PhoneLoginView(),
    );
  }
}

class _PhoneLoginView extends StatefulWidget {
  const _PhoneLoginView();

  @override
  State<_PhoneLoginView> createState() => _PhoneLoginViewState();
}

class _PhoneLoginViewState extends State<_PhoneLoginView> {
  final TextEditingController _controller = TextEditingController(text: '+91');

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<PhoneLoginCubit, PhoneLoginState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, PhoneLoginState state) {
        if (state.status == PhoneLoginStatus.success) {
          Navigator.pushNamed(context, Routes.otpVerify, arguments: state.phone);
        } else if (state.status == PhoneLoginStatus.failure) {
          // Surface the OTP-request failure instead of silently reverting the
          // button. The message is the mapper's generic, PII-safe copy.
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(
              SnackBar(
                backgroundColor: AppColors.danger,
                content: Text(
                  state.message ?? 'Could not send OTP. Please try again.',
                ),
              ),
            );
        }
      },
      builder: (BuildContext context, PhoneLoginState state) {
        return BbScaffold(
          appBar: const BbAppBar(title: 'Login'),
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: AppSpacing.s7),
              Text('Enter your phone number',
                  style: AppTypography.display(size: AppTypography.sizeXl)),
              const SizedBox(height: AppSpacing.s2),
              Text(
                'We send a one-time code to log you in.',
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.s6),
              TextField(
                controller: _controller,
                keyboardType: TextInputType.phone,
                style: AppTypography.mono(size: AppTypography.sizeLg),
                decoration: const InputDecoration(
                  hintText: '+91XXXXXXXXXX',
                  prefixIcon: Icon(Icons.phone_outlined),
                ),
              ),
              const SizedBox(height: AppSpacing.s4),
              Row(
                children: <Widget>[
                  const Icon(Icons.lock_outline,
                      size: 18, color: AppColors.textMuted),
                  const SizedBox(width: AppSpacing.s2),
                  Expanded(
                    child: Text(
                      'Your number stays private. We never show it to anyone.',
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.s7),
              BbButton(
                label: state.isSubmitting ? 'Sending OTP…' : 'Send OTP',
                block: true,
                loading: state.isSubmitting,
                onPressed: state.isSubmitting
                    ? null
                    : () => context
                        .read<PhoneLoginCubit>()
                        .submit(_controller.text.trim()),
              ),
            ],
          ),
        );
      },
    );
  }
}
