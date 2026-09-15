import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/phone_format.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import 'cubit/phone_login_cubit.dart';
import 'otp_verify_screen.dart';

/// Phone login — onboarding kit **Screen 2**: the Shift Blue header, a
/// `MOBILE NUMBER` label over a white 56px field with a fixed `+91` and a
/// hairline divider, the "Verified & Secure Platform" trust line, and the
/// yellow "Send OTP" CTA.
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
  /// Holds ONLY the 10 national digits. `+91` is fixed chrome drawn beside the
  /// field, not editable content: seeding it into the controller let the worker
  /// backspace it away, and the raw field text went to requestOtp() verbatim —
  /// so a phone that had lost its `+91` was sent as-is and the OTP simply never
  /// arrived.
  final TextEditingController _controller = TextEditingController();

  /// Drives the field's focused border (the kit's `borderActive`).
  final FocusNode _focusNode = FocusNode();

  /// Enables the CTA only once the number can actually be dialled.
  bool get _isComplete => _controller.text.length == kNationalNumberDigits;

  @override
  void initState() {
    super.initState();
    // Repaint the CTA as the digit count crosses 10, and the border on focus.
    _controller.addListener(_onChanged);
    _focusNode.addListener(_onChanged);
  }

  void _onChanged() => setState(() {});

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    _focusNode.removeListener(_onChanged);
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  /// Back from login. The splash hands over with `go`, so there is usually
  /// nothing to pop — fall back to the welcome screen rather than a dead arrow.
  void _back(BuildContext context) {
    final NavigatorState nav = Navigator.of(context);
    if (nav.canPop()) {
      nav.pop();
      return;
    }
    GoRouter.maybeOf(context)?.go(Routes.splash);
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<PhoneLoginCubit, PhoneLoginState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, PhoneLoginState state) {
        if (state.status == PhoneLoginStatus.success) {
          // go_router push (ADR-0023). The submitted phone rides as typed
          // `extra`. #336 — the server's resend cooldown travels with it, so
          // the OTP screen opens with the countdown already running.
          context.pushOnce(
            Routes.otpVerify,
            extra: OtpVerifyArgs(phone: state.phone, resendIn: state.resendIn),
          );
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
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              ShiftBlueHeader(
                title: 'Enter your phone number',
                subtitle: 'We send a one-time code to log you in.',
                onBack: () => _back(context),
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  child: OnboardingBody(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          'MOBILE NUMBER',
                          style: OnboardingTypography.fieldMicroLabel(),
                        ),
                        const SizedBox(height: 8),
                        _PhoneField(
                          controller: _controller,
                          focusNode: _focusNode,
                        ),
                        const SizedBox(height: 18),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: <Widget>[
                            const Icon(
                              Icons.verified_user_outlined,
                              size: 16,
                              color: OnboardingColors.successGreen,
                            ),
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text(
                                'Verified & Secure Platform',
                                style: OnboardingTypography.inter(
                                  size: 12,
                                  weight: FontWeight.w500,
                                  color: OnboardingColors.ink600,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 28),
                        PrimaryActionButton(
                          label: 'Send OTP',
                          showArrow: false,
                          isLoading: state.isSubmitting,
                          // Disabled until 10 digits — the cubit/manager
                          // contract is E.164, and a half-typed number can
                          // only ever fail.
                          onPressed: state.isSubmitting || !_isComplete
                              ? null
                              : () => context
                                  .read<PhoneLoginCubit>()
                                  .submit(toE164(_controller.text)),
                        ),
                      ],
                    ),
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

/// The kit's phone input: a 56px white box, 14 radius, fixed `+91`, a 1×24
/// divider, then the digits in Roboto Mono.
class _PhoneField extends StatelessWidget {
  const _PhoneField({required this.controller, required this.focusNode});

  final TextEditingController controller;
  final FocusNode focusNode;

  @override
  Widget build(BuildContext context) {
    final bool focused = focusNode.hasFocus;
    return GestureDetector(
      // The whole box is the target, not only the text run inside it.
      onTap: focusNode.requestFocus,
      child: Container(
        height: 56,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        decoration: BoxDecoration(
          color: OnboardingColors.paperWhite,
          borderRadius: BorderRadius.circular(OnboardingRadii.phoneField),
          border: Border.all(
            color: focused
                ? OnboardingColors.borderActive
                : OnboardingColors.borderDefault,
            width: focused ? 1.8 : 1.2,
          ),
        ),
        child: Row(
          children: <Widget>[
            // Fixed chrome — drawn beside the field, never inside its
            // controller, so it cannot be selected or backspaced away.
            Text(
              kIndiaDialCode,
              style: OnboardingTypography.subheadBold(
                color: OnboardingColors.shiftBlue,
              ),
            ),
            Container(
              width: 1,
              height: 24,
              margin: const EdgeInsets.symmetric(horizontal: 14),
              color: OnboardingColors.borderDefault,
            ),
            Expanded(
              child: TextField(
                controller: controller,
                focusNode: focusNode,
                keyboardType: TextInputType.phone,
                style: OnboardingTypography.mono(
                  size: 16,
                  weight: FontWeight.w600,
                  color: OnboardingColors.ink900,
                ),
                // Digits only, capped at 10: the field cannot hold a country
                // code, spaces, or punctuation, so there is nothing to strip
                // and nothing malformed to send.
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(kNationalNumberDigits),
                ],
                decoration: InputDecoration(
                  hintText: 'XXXXXXXXXX',
                  hintStyle: OnboardingTypography.mono(
                    size: 16,
                    weight: FontWeight.w600,
                    color: OnboardingColors.ink500,
                  ),
                  counterText: '',
                  filled: false,
                  isCollapsed: true,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
