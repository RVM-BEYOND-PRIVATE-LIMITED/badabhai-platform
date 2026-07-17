import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/phone_format.dart';
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
  /// Holds ONLY the 10 national digits. `+91` is fixed chrome (a prefixText), not
  /// editable content: seeding it into the controller let the worker backspace it
  /// away, and the raw field text went to requestOtp() verbatim — so a phone that
  /// had lost its `+91` was sent as-is and the OTP simply never arrived.
  final TextEditingController _controller = TextEditingController();

  /// Enables the CTA only once the number can actually be dialled.
  bool get _isComplete => _controller.text.length == kNationalNumberDigits;

  @override
  void initState() {
    super.initState();
    // Repaint the CTA as the digit count crosses 10.
    _controller.addListener(_onChanged);
  }

  void _onChanged() => setState(() {});

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<PhoneLoginCubit, PhoneLoginState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, PhoneLoginState state) {
        if (state.status == PhoneLoginStatus.success) {
          // go_router push (the app is on MaterialApp.router — ADR-0023). The
          // submitted phone rides as typed `extra`; the OTP route reads it via
          // `s.extra`. (Was a stale Navigator-1.0 pushNamed that would throw
          // "Could not find a generator for route" under go_router.)
          context.push(Routes.otpVerify, extra: state.phone);
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
                // Digits only, capped at 10: the field cannot hold a country
                // code, spaces, or punctuation, so there is nothing to strip and
                // nothing malformed to send.
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(kNationalNumberDigits),
                ],
                decoration: InputDecoration(
                  // Fixed chrome — rendered by the field, not stored in the
                  // controller, so it cannot be selected or backspaced away.
                  prefixText: '$kIndiaDialCode ',
                  prefixStyle: AppTypography.mono(size: AppTypography.sizeLg),
                  hintText: 'XXXXXXXXXX',
                  prefixIcon: const Icon(Icons.phone_outlined),
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
                // Disabled until 10 digits — the cubit/manager contract is
                // E.164, and a half-typed number can only ever fail.
                onPressed: state.isSubmitting || !_isComplete
                    ? null
                    : () => context
                        .read<PhoneLoginCubit>()
                        .submit(toE164(_controller.text)),
              ),
            ],
          ),
        );
      },
    );
  }
}
