import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
import 'cubit/enter_pin_cubit.dart';
import 'widgets/bb_pin_keypad.dart';
import 'widgets/bb_pin_view.dart';

/// PIN length the app uses everywhere (set + unlock). Single source so the dot
/// count and the auto-submit threshold never drift.
const int kPinLength = 4;

/// Enter-PIN (unlock) — the fast path on cold start and after a re-lock.
///
/// The masked keypad assembles the PIN in LOCAL state only; it is forwarded to
/// the cubit on the last digit and cleared from memory immediately. On a wrong
/// PIN the dots flash crimson and the NEUTRAL "PIN sahi nahi…" copy shows — the
/// backend gives one opaque 401 per failure, so there is no attempts/countdown
/// UI. After a few soft fails the "PIN bhool gaye?" link is emphasized; it starts
/// the forgot-PIN flow.
class EnterPinScreen extends StatelessWidget {
  const EnterPinScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<EnterPinCubit>(
      create: (_) => locator<EnterPinCubit>(),
      child: const _EnterPinView(),
    );
  }
}

class _EnterPinView extends StatefulWidget {
  const _EnterPinView();

  @override
  State<_EnterPinView> createState() => _EnterPinViewState();
}

class _EnterPinViewState extends State<_EnterPinView> {
  /// The PIN buffer — LOCAL widget state only. Never persisted, never logged;
  /// cleared after each submit.
  String _pin = '';

  void _onDigit(String d) {
    if (_pin.length >= kPinLength) return;
    setState(() => _pin += d);
    if (_pin.length == kPinLength) {
      final String pin = _pin;
      // Clear the on-screen buffer immediately; the cubit holds nothing.
      setState(() => _pin = '');
      context.read<EnterPinCubit>().unlock(pin);
    }
  }

  void _onBackspace() {
    if (_pin.isEmpty) return;
    setState(() => _pin = _pin.substring(0, _pin.length - 1));
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<EnterPinCubit, EnterPinState>(
      listenWhen: (EnterPinState p, EnterPinState c) => p.status != c.status,
      listener: (BuildContext context, EnterPinState state) {
        if (state.status == EnterPinStatus.done) {
          // Authenticated — the router redirect lifts us into the shell. Nudge
          // it toward the Resume tab (the worker's home after unlock) — unless
          // the server said this worker has NO active consent (TD62): then the
          // consent gate comes first. Only a definitive false routes there.
          final bool needsConsent =
              locator<AuthSessionManager>().consentAccepted == false;
          context.go(needsConsent ? Routes.consent : Routes.resume);
        }
      },
      builder: (BuildContext context, EnterPinState state) {
        final bool error = state.status == EnterPinStatus.failure;
        return BbScaffold(
          body: Column(
            children: <Widget>[
              const Spacer(flex: 2),
              const Icon(Icons.lock_outline,
                  size: 40, color: AppColors.brand),
              const SizedBox(height: AppSpacing.s4),
              Text('PIN daalein',
                  style: AppTypography.display(size: AppTypography.sizeXl)),
              const SizedBox(height: AppSpacing.s2),
              Text(
                'Apne account mein wapas aane ke liye PIN daalein.',
                textAlign: TextAlign.center,
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.s7),
              BbPinView(
                length: kPinLength,
                filled: _pin.length,
                error: error,
              ),
              const SizedBox(height: AppSpacing.s4),
              SizedBox(
                height: AppSpacing.s6,
                child: state.message != null
                    ? Text(
                        state.message!,
                        textAlign: TextAlign.center,
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.danger,
                        ),
                      )
                    : null,
              ),
              const SizedBox(height: AppSpacing.s4),
              BbPinKeypad(
                // Keypad disables ONLY while submitting — no lockout state.
                enabled: !state.isSubmitting,
                onDigit: _onDigit,
                onBackspace: _onBackspace,
              ),
              const Spacer(flex: 1),
              TextButton(
                onPressed: () => context.push(Routes.forgotPin),
                child: Text(
                  // After enough soft fails, nudge harder toward the reset flow.
                  state.suggestForgot
                      ? 'PIN bhool gaye? Naya PIN banayein'
                      : 'PIN bhool gaye?',
                  style: AppTypography.body(
                    weight: FontWeight.w700,
                    color: state.suggestForgot
                        ? AppColors.brand
                        : AppColors.textLink,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.s4),
            ],
          ),
        );
      },
    );
  }
}
