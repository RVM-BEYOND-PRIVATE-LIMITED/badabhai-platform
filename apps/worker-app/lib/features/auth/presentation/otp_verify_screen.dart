import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/session/session_repository.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/date_label.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
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

  /// Post-verify success. If a deletion is pending (ADR-0031 grace window) the
  /// EXPLICIT cancel prompt comes FIRST — ruling (a): login must never
  /// auto-cancel a formally-confirmed deletion — then routing proceeds either
  /// way (a declined/failed cancel can still be done later from Settings).
  Future<void> _onVerified(BuildContext context, OtpVerifyState state) async {
    final DateTime? pendingDeletion = state.deletionScheduledFor;
    if (pendingDeletion != null) {
      await _promptPendingDeletion(context, pendingDeletion);
      if (!context.mounted) return;
    }
    _routeNext(context, state.next!);
  }

  /// Route off the resolved next-step (exhaustive — all three arms):
  void _routeNext(BuildContext context, OtpNext next) {
    switch (next) {
      case OtpNext.onboarding:
        // Persistent-auth OFF (real/default build until the backend
        // /auth/* contract lands): replicate main's OTP→consent flow —
        // PUSH the consent gate, then the worker walks consent → name →
        // chat → profile → resume. No PIN; the auth redirect is inert.
        context.push(Routes.consent);
      case OtpNext.setPin:
        // New user (gate ON) → choose a PIN before the shell.
        context.go(Routes.setPin);
      case OtpNext.authenticated:
        // Returning worker with a PIN (gate ON) → straight to the shell
        // (no re-profiling) — unless the server said this worker has NO
        // active consent (TD62): then the consent gate comes first. Only a
        // definitive false routes there (null = old server, pass). The
        // redirect blocks onboarding routes anyway.
        final bool needsConsent =
            locator<AuthSessionManager>().consentAccepted == false;
        context.go(needsConsent ? Routes.consent : Routes.resume);
    }
  }

  /// The pending-deletion prompt: a non-backdrop-dismissible choice between
  /// cancelling the deletion and letting it proceed. Backdrop dismissal is off
  /// because this is a formal choice — but "Nahin, delete hone dein" routes on
  /// without touching the schedule.
  Future<void> _promptPendingDeletion(
    BuildContext context,
    DateTime scheduledFor,
  ) async {
    final bool cancelRequested = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (BuildContext dialogContext) => AlertDialog(
            title: const Text('Account delete hone wala hai'),
            content: Text(
              'Aapka account ${absoluteDateLabel(scheduledFor)} ko delete ho '
              'jaayega. Kya aap delete cancel karna chahte hain?',
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                style: TextButton.styleFrom(foregroundColor: AppColors.danger),
                child: const Text('Nahin, delete hone dein'),
              ),
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: const Text('Delete cancel karein'),
              ),
            ],
          ),
        ) ??
        false;
    if (!cancelRequested || !context.mounted) return;
    await _cancelPendingDeletion(context);
  }

  /// Calls the cancel route with the FRESH session token the verify just
  /// bridged. On success the SessionRepository flag clears; on failure the
  /// honest reason shows and routing continues — the worker can still cancel
  /// from the Settings banner (the pending flag stays set).
  Future<void> _cancelPendingDeletion(BuildContext context) async {
    // Capture the messenger before the async gap (use_build_context_synchronously).
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final SessionRepository session = locator<SessionRepository>();
    try {
      final String? token = session.sessionToken;
      if (token == null || token.isEmpty) {
        throw const UnauthorizedFailure();
      }
      await locator<ApiClient>().cancelAccountDelete(authToken: token);
      session.setDeletionScheduledFor(null);
      messenger
        ..clearSnackBars()
        ..showSnackBar(
            const SnackBar(content: Text('Account delete cancel ho gaya')));
    } catch (error) {
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(
          backgroundColor: AppColors.danger,
          content: Text(failureReason(mapError(error)).reason),
        ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final String phone = widget.phone;
    return BlocConsumer<OtpVerifyCubit, OtpVerifyState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, OtpVerifyState state) {
        if (state.status == OtpVerifyStatus.success) {
          // Fire-and-forget: the pending-deletion prompt (if any) is awaited
          // inside, then routing runs. The listener itself stays sync.
          unawaited(_onVerified(context, state));
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
                'Sent to $phone',
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.s6),
              TextField(
                controller: _controller,
                keyboardType: TextInputType.number,
                textAlign: TextAlign.center,
                // OS-level one-time-code assist: iOS surfaces the SMS code above
                // the keyboard out of the box; Android maps this to
                // AUTOFILL_HINT_SMS_OTP. Fully-silent auto-read (SMS Retriever)
                // additionally needs the app-hash embedded in the DLT SMS body.
                autofillHints: const <String>[AutofillHints.oneTimeCode],
                decoration: const InputDecoration(hintText: '— — — —'),
                style: AppTypography.mono(
                  size: AppTypography.size2xl,
                  weight: FontWeight.w700,
                  letterSpacing: 12,
                ),
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
