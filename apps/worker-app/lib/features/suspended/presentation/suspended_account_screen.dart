import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/api/api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../auth/domain/auth_session_manager.dart';
import 'cubit/suspended_account_cubit.dart';

/// Fade-in duration for the suspended screen. Deliberately a calm 200ms: this
/// is information, not an error, so there is no shake and no error haptic.
const Duration kSuspendedScreenFadeDuration = Duration(milliseconds: 200);

const String kSuspendedTitle = 'Account suspend hai';
const String kSuspendedMessage =
    'Aapka BadaBhai account admin ne suspend kiya hai. Isliye abhi sign in '
    'nahi ho sakta.';
const String kSuspendedSupport =
    'Madad ke liye BadaBhai support se sampark karein.';

const Key kSuspendedScreenFadeKey = Key('suspended_screen_fade');
const Key kSuspendedDeleteButtonKey = Key('suspended_delete_button');
const Key kSuspendedWithdrawButtonKey = Key('suspended_withdraw_button');

/// The ONE app-level destination for a suspended worker (#2687).
///
/// The router sends every refusal point here — phone-code verify, PIN unlock,
/// token refresh, and any generic authenticated request — after the session has
/// been cleared. It never routes back into consent or sign-in; the worker leaves
/// only by reopening the app after the account is reinstated.
///
/// The DPDP exits are offered ONLY when the backend supplied a restricted token
/// in the 403 body. That token is used solely for account-delete request/
/// confirm/cancel and consent-withdraw; it is never stored as a session and
/// never used to register push. A backend without it renders the message and the
/// support contact — no dead buttons.
class SuspendedAccountScreen extends StatelessWidget {
  const SuspendedAccountScreen({super.key, this.restrictedToken, this.api});

  /// Test seam: when null, the screen reads the in-memory token the app root
  /// captured from the 403 body. It is NEVER read from persistent storage.
  final String? restrictedToken;

  /// Test seam for the DPDP calls; production resolves the app-wide client.
  final ApiClient? api;

  String? _token(BuildContext context) {
    if (restrictedToken != null) return restrictedToken;
    if (!locator.isRegistered<AuthSessionManager>()) return null;
    return locator<AuthSessionManager>().restrictedToken;
  }

  @override
  Widget build(BuildContext context) {
    return BlocProvider<SuspendedAccountCubit>(
      create: (_) =>
          SuspendedAccountCubit(restrictedToken: _token(context), api: api),
      child: const _SuspendedAccountView(),
    );
  }
}

class _SuspendedAccountView extends StatelessWidget {
  const _SuspendedAccountView();

  ScaffoldMessengerState _messenger(BuildContext context) =>
      ScaffoldMessenger.of(context);

  void _showMessage(BuildContext context, String message) {
    _messenger(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _onDelete(BuildContext context) async {
    final SuspendedAccountCubit cubit = context.read<SuspendedAccountCubit>();
    final bool proceed = await showBbConfirm(
      context,
      title: 'Account delete karein?',
      message:
          'OTP verify karne ke baad aapka account 7 din mein delete ho jaata '
          'hai. Is dauraan aap kabhi bhi cancel kar sakte hain.',
      confirmLabel: 'Delete karein',
      destructive: true,
    );
    if (!proceed || !context.mounted) return;

    await cubit.requestDelete();
    if (!context.mounted) return;
    final SuspendedAccountState s = cubit.state;
    if (s.status != SuspendedAccountStatus.otpSent) {
      _showMessage(context, failureReason(s.failure).reason);
      return;
    }
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      barrierColor: OnboardingColors.scrim,
      builder: (BuildContext dialogContext) =>
          BlocProvider<SuspendedAccountCubit>.value(
            value: cubit,
            child: const _SuspendedDeleteOtpDialog(),
          ),
    );
  }

  Future<void> _onWithdraw(BuildContext context) async {
    final SuspendedAccountCubit cubit = context.read<SuspendedAccountCubit>();
    final bool proceed = await showBbConfirm(
      context,
      title: 'Consent wapas lein?',
      message:
          'Aapki DPDP consent hat jaayegi. Aapka account tab bhi suspend rahega.',
      confirmLabel: 'Consent wapas lein',
      destructive: true,
    );
    if (!proceed || !context.mounted) return;
    await cubit.withdrawConsent();
  }

  @override
  Widget build(BuildContext context) {
    return BlocListener<SuspendedAccountCubit, SuspendedAccountState>(
      listenWhen: (SuspendedAccountState prev, SuspendedAccountState curr) =>
          prev.status != curr.status,
      listener: (BuildContext context, SuspendedAccountState state) {
        switch (state.status) {
          case SuspendedAccountStatus.deletionScheduled:
            _showMessage(
              context,
              'Account delete request confirm ho gaya. 7 din mein delete hoga.',
            );
          case SuspendedAccountStatus.consentWithdrawn:
            _showMessage(context, 'Consent wapas le li gayi hai.');
          case SuspendedAccountStatus.error:
            // A failed DELETE-CONFIRM is shown inline by the OTP dialog, so a
            // second snackbar here would double-report it.
            if (state.action == SuspendedAction.withdrawConsent) {
              _showMessage(context, failureReason(state.failure).reason);
            }
          case SuspendedAccountStatus.idle:
          case SuspendedAccountStatus.requestingOtp:
          case SuspendedAccountStatus.otpSent:
          case SuspendedAccountStatus.confirming:
          case SuspendedAccountStatus.withdrawing:
            break;
        }
      },
      child: Scaffold(
        backgroundColor: OnboardingColors.canvasBg,
        body: SafeArea(
          child: TweenAnimationBuilder<double>(
            key: kSuspendedScreenFadeKey,
            tween: Tween<double>(begin: 0, end: 1),
            duration: kSuspendedScreenFadeDuration,
            curve: Curves.easeOut,
            builder: (BuildContext context, double opacity, Widget? child) =>
                Opacity(opacity: opacity, child: child),
            child: OnboardingBody(
              fillViewport: true,
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const _SuspendedGlyph(),
                  const SizedBox(height: 24),
                  Text(
                    kSuspendedTitle,
                    textAlign: TextAlign.center,
                    style: OnboardingTypography.anek(
                      size: 28,
                      weight: FontWeight.w800,
                      color: OnboardingColors.shiftBlue,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    kSuspendedMessage,
                    textAlign: TextAlign.center,
                    style: OnboardingTypography.inter(
                      size: 15,
                      height: 1.5,
                      color: OnboardingColors.ink600,
                    ),
                  ),
                  const SizedBox(height: 24),
                  const _SupportCallout(),
                  BlocBuilder<SuspendedAccountCubit, SuspendedAccountState>(
                    buildWhen:
                        (
                          SuspendedAccountState prev,
                          SuspendedAccountState curr,
                        ) =>
                            prev.status != curr.status ||
                            prev.action != curr.action,
                    builder: (BuildContext context, SuspendedAccountState state) {
                      final SuspendedAccountCubit cubit = context
                          .read<SuspendedAccountCubit>();
                      // No restricted token on the 403 → no DPDP actions at all.
                      // Message + support contact only, per #2687.
                      if (!cubit.hasRestrictedToken) {
                        return const SizedBox.shrink();
                      }
                      final bool busy = state.isBusy;
                      final bool deleted =
                          state.status ==
                          SuspendedAccountStatus.deletionScheduled;
                      final bool withdrawn =
                          state.status ==
                          SuspendedAccountStatus.consentWithdrawn;
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          const SizedBox(height: 28),
                          BbButton(
                            buttonKey: kSuspendedDeleteButtonKey,
                            label: 'Mera account delete karein',
                            variant: BbButtonVariant.danger,
                            block: true,
                            loading:
                                state.status ==
                                    SuspendedAccountStatus.requestingOtp ||
                                state.status ==
                                    SuspendedAccountStatus.confirming,
                            onPressed: (busy || deleted)
                                ? null
                                : () => _onDelete(context),
                          ),
                          const SizedBox(height: 12),
                          BbButton(
                            buttonKey: kSuspendedWithdrawButtonKey,
                            label: 'Consent wapas lein',
                            variant: BbButtonVariant.outline,
                            block: true,
                            loading:
                                state.status ==
                                SuspendedAccountStatus.withdrawing,
                            onPressed: (busy || withdrawn)
                                ? null
                                : () => _onWithdraw(context),
                          ),
                        ],
                      );
                    },
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SuspendedGlyph extends StatelessWidget {
  const _SuspendedGlyph();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 88,
        height: 88,
        alignment: Alignment.center,
        decoration: const BoxDecoration(
          color: OnboardingColors.infoBg,
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.lock_outline_rounded,
          size: 44,
          color: OnboardingColors.shiftBlue,
        ),
      ),
    );
  }
}

class _SupportCallout extends StatelessWidget {
  const _SupportCallout();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: OnboardingColors.infoBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        border: Border.all(color: OnboardingColors.infoBorder),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: OnboardingColors.shiftBlue,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.support_agent_rounded,
              size: 18,
              color: OnboardingColors.paperWhite,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              kSuspendedSupport,
              style: OnboardingTypography.inter(
                size: 14,
                height: 1.45,
                weight: FontWeight.w600,
                color: OnboardingColors.infoTitle,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The delete-OTP step. Mirrors the Settings account-delete dialog's worker-safe
/// copy and error handling, but every call uses the restricted token only.
class _SuspendedDeleteOtpDialog extends StatefulWidget {
  const _SuspendedDeleteOtpDialog();

  @override
  State<_SuspendedDeleteOtpDialog> createState() =>
      _SuspendedDeleteOtpDialogState();
}

class _SuspendedDeleteOtpDialogState extends State<_SuspendedDeleteOtpDialog> {
  final TextEditingController _otp = TextEditingController();
  Timer? _timer;
  int _remaining = 0;

  @override
  void initState() {
    super.initState();
    _remaining = context.read<SuspendedAccountCubit>().state.resendInSeconds;
    _startCountdown();
  }

  void _startCountdown() {
    _timer?.cancel();
    if (_remaining <= 0) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (!mounted) return;
      setState(() => _remaining = _remaining > 0 ? _remaining - 1 : 0);
      if (_remaining <= 0) t.cancel();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _otp.dispose();
    super.dispose();
  }

  void _resend() {
    unawaited(context.read<SuspendedAccountCubit>().requestDelete());
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<SuspendedAccountCubit, SuspendedAccountState>(
      listener: (BuildContext context, SuspendedAccountState state) {
        if (state.status == SuspendedAccountStatus.deletionScheduled) {
          Navigator.of(context).pop(true);
          return;
        }
        if (state.status == SuspendedAccountStatus.otpSent) {
          setState(() => _remaining = state.resendInSeconds);
          _startCountdown();
        }
      },
      builder: (BuildContext context, SuspendedAccountState state) {
        final bool sending =
            state.status == SuspendedAccountStatus.requestingOtp;
        final bool busy =
            state.status == SuspendedAccountStatus.confirming || sending;
        final bool isError = state.status == SuspendedAccountStatus.error;
        return AlertDialog(
          backgroundColor: OnboardingColors.paperWhite,
          elevation: 0,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.all(
              Radius.circular(OnboardingRadii.card),
            ),
          ),
          titlePadding: const EdgeInsets.fromLTRB(24, 24, 24, 12),
          contentPadding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
          title: Text(
            'OTP daalein',
            style: OnboardingTypography.anek(size: 18, weight: FontWeight.w800),
          ),
          scrollable: true,
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'Aapke phone par bheja gaya OTP daalein — verify hote hi account '
                '7 din mein delete ho jaayega.',
                style: OnboardingTypography.inter(
                  size: 14,
                  height: 1.45,
                  color: OnboardingColors.ink600,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _otp,
                autofocus: true,
                enabled: !busy,
                keyboardType: TextInputType.number,
                maxLength: 8,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                ],
                style: OnboardingTypography.mono(
                  size: 16,
                  weight: FontWeight.w700,
                  color: OnboardingColors.ink900,
                ),
                decoration: const InputDecoration(
                  counterText: '',
                  hintText: 'OTP',
                ),
                onChanged: (_) => setState(() {}),
              ),
              if (isError) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  failureReason(state.failure).reason,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w500,
                    color: OnboardingColors.errorRed,
                  ),
                ),
              ],
              const SizedBox(height: 8),
              if (_remaining > 0)
                Text(
                  'Dobara bhejne ke liye $_remaining second',
                  style: OnboardingTypography.inter(
                    size: 12,
                    color: OnboardingColors.ink500,
                  ),
                )
              else
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    style: TextButton.styleFrom(
                      foregroundColor: OnboardingColors.shiftBlue,
                      textStyle: OnboardingTypography.inter(
                        size: 13,
                        weight: FontWeight.w700,
                        color: OnboardingColors.shiftBlue,
                      ),
                      minimumSize: const Size(
                        OnboardingLayout.tapTarget,
                        OnboardingLayout.tapTarget,
                      ),
                      tapTargetSize: MaterialTapTargetSize.padded,
                    ),
                    onPressed: busy ? null : _resend,
                    child: sending
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: OnboardingColors.shiftBlue,
                            ),
                          )
                        : const Text('Dobara OTP bhejein'),
                  ),
                ),
            ],
          ),
          actions: <Widget>[
            TextButton(
              style: TextButton.styleFrom(
                foregroundColor: OnboardingColors.ink600,
                minimumSize: const Size(
                  OnboardingLayout.tapTarget,
                  OnboardingLayout.tapTarget,
                ),
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              onPressed: busy ? null : () => Navigator.of(context).pop(false),
              child: const Text('Rehne dein'),
            ),
            TextButton(
              style: TextButton.styleFrom(
                foregroundColor: OnboardingColors.errorRed,
                minimumSize: const Size(
                  OnboardingLayout.tapTarget,
                  OnboardingLayout.tapTarget,
                ),
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              onPressed: (busy || _otp.text.length < 4)
                  ? null
                  : () => context.read<SuspendedAccountCubit>().confirmDelete(
                      _otp.text,
                    ),
              child: state.status == SuspendedAccountStatus.confirming
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: OnboardingColors.errorRed,
                      ),
                    )
                  : const Text('Delete karein'),
            ),
          ],
        );
      },
    );
  }
}
