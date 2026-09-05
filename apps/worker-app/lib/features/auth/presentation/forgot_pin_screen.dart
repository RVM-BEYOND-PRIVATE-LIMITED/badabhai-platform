import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/phone_format.dart';
import '../../../core/auth/auth_error_messages.dart';
import '../../../core/auth/auth_failure.dart';
import '../../../core/di/locator.dart';
import '../../../core/otp/sms_otp_autofill.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scroll_safe_body.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
import 'widgets/bb_set_pin_form.dart';

/// Forgot-PIN: the dedicated PIN-RESET flow (NOT the normal OTP login).
///
/// Three phases, in the order a worker expects — the OTP comes BEFORE the new
/// PIN:
///  1. phone → [AuthSessionManager.requestPinReset] (POST /auth/pin/reset/request)
///  2. otp   → enter the code that just arrived (Android SMS auto-fills it)
///  3. pin   → ONE page: enter + confirm a brand-new 4-digit PIN together (no
///     next-screen transition between them — see [BbSetPinForm]), then
///     [AuthSessionManager.confirmPinReset] (POST /auth/pin/reset/confirm) with
///     {phone, otp, newPin} in ONE call.
///
/// EVERY error on every step is a CENTRED, blocking [showBbAlert] with a single
/// "Theek hai" button — a couldn't-send-OTP, a missing code, a bad/expired code,
/// a guessable PIN, a confirm mismatch, a server weak-PIN. There is no tiny
/// inline red text a first-time, low-literacy worker would scroll past.
///
/// The backend verifies the OTP only at that final `/confirm` (there is no
/// standalone reset-OTP verify), so a wrong/expired code surfaces there and
/// returns the worker to the OTP step; a weak/format PIN re-collects the PIN. On
/// success it routes to [Routes.pin] — the redirect bounces to /login if the
/// worker is now loggedOut. A guessable PIN (1111 / 1234) is BLOCKED CLIENT-SIDE
/// the moment it is entered, so it never reaches the confirm call.
class ForgotPinScreen extends StatefulWidget {
  const ForgotPinScreen({super.key});

  @override
  State<ForgotPinScreen> createState() => _ForgotPinScreenState();
}

enum _Phase { phone, otp, pin }

class _ForgotPinScreenState extends State<ForgotPinScreen> {
  final AuthSessionManager _manager = locator<AuthSessionManager>();

  /// Holds ONLY the 10 national digits — `+91` is fixed chrome, not editable
  /// text. Seeding it into the controller let the worker backspace it away, and
  /// the raw text went straight to requestPinReset(), sending a malformed number
  /// (identical bug to the login screen).
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _otp = TextEditingController();

  final GlobalKey<BbSetPinFormState> _pinFormKey =
      GlobalKey<BbSetPinFormState>();

  _Phase _phase = _Phase.phone;

  bool _busy = false;

  /// True while an alert dialog is open, so a rapid tap or a rebuild can't stack
  /// a second dialog on top of the first.
  bool _dialogOpen = false;

  /// Android SMS auto-read for the reset OTP. Null when the locator has no
  /// instance (tests) — the screen stays usable by typing.
  SmsOtpAutofill? _autofill;
  StreamSubscription<String>? _codeSub;

  @override
  void initState() {
    super.initState();
    // This is the app's SECOND OTP surface (login is the other). It bypasses
    // PhoneLoginCubit, so the SMS auto-read has to be wired here too — otherwise
    // a PIN reset is the one flow left where the worker still types the code.
    if (!locator.isRegistered<SmsOtpAutofill>()) return;
    final SmsOtpAutofill autofill = locator<SmsOtpAutofill>();
    _autofill = autofill;
    _codeSub = autofill.codes.listen(_onSmsCode);
  }

  /// Fill the reset OTP from the SMS. Not auto-submitted: the worker still picks
  /// a new PIN after this, so there is nothing to submit yet.
  void _onSmsCode(String code) {
    if (!mounted) return;
    setState(() {
      _otp.text = code;
      _otp.selection = TextSelection.collapsed(offset: _otp.text.length);
    });
  }

  @override
  void dispose() {
    _codeSub?.cancel();
    _autofill?.stopListening();
    _phone.dispose();
    _otp.dispose();
    super.dispose();
  }

  /// The one error surface: a centred, blocking dialog with a "Theek hai"
  /// button. Guarded by [_dialogOpen] so a fast retry can't stack dialogs.
  Future<void> _showErrorAlert(String title, String message) async {
    if (_dialogOpen) return;
    _dialogOpen = true;
    await showBbAlert(context, title: title, message: message);
    if (mounted) _dialogOpen = false;
  }

  // --- phase 1: phone -------------------------------------------------------

  Future<void> _sendReset() async {
    setState(() => _busy = true);
    try {
      // Opened BEFORE the request (User Consent only matches an SMS that lands
      // after the window opens) and NOT awaited — a wedged Play Services must
      // never stall the reset SMS itself. Never throws.
      unawaited(_openOtpAutofillWindow());
      await _manager.requestPinReset(toE164(_phone.text));
      if (!mounted) return;
      // OTP FIRST — the worker enters the code before choosing a new PIN.
      setState(() => _phase = _Phase.otp);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      unawaited(_showErrorAlert('OTP nahi bhej paye', authErrorMessage(f, 'hi')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openOtpAutofillWindow() async {
    try {
      await _autofill?.startListening();
    } catch (_) {
      // No Play Services → the worker types the code.
    }
  }

  // --- phase 2: enter the OTP ------------------------------------------------

  /// Move on to choose a new PIN once a code has been entered. The code itself
  /// is verified with the new PIN at [_confirmReset] (the backend has no
  /// standalone reset-OTP verify), so a wrong code returns here from that step.
  void _otpContinue() {
    // The CTA is disabled until a code is entered (see [_otpView]), so there is
    // no empty-OTP error to surface here.
    setState(() => _phase = _Phase.pin);
  }

  // --- phase 3: choose a new PIN (enter + confirm, one page) ----------------

  /// Submit {phone, otp, newPin}. The OTP is verified here (there is no earlier
  /// verify), so a bad/expired code returns to the OTP step; a weak PIN re-opens
  /// the PIN step. Every failure is a dialog.
  Future<void> _confirmReset(String newPin) async {
    setState(() => _busy = true);
    try {
      await _manager.confirmPinReset(
        // E.164, exactly as the request step sent it. The controller holds only
        // the national digits now, so composing here is mandatory.
        toE164(_phone.text),
        _otp.text.trim(),
        newPin,
      );
      if (!mounted) return;
      // The redirect resolves the destination: locked → enter the new PIN at
      // /pin; loggedOut → bounced to /login.
      context.go(Routes.pin);
    } on AuthFailure catch (f) {
      if (!mounted) return;
      if (f.code == AuthErrorCode.pinWeak) {
        // Server weak-PIN → re-collect the PIN behind a dialog, same phase.
        _pinFormKey.currentState?.reset();
        unawaited(_showErrorAlert('Yeh PIN aasan hai', authErrorMessage(f, 'hi')));
      } else {
        // Bad/expired OTP (401 → otpInvalid) or anything else → back to the OTP
        // step with the honest reason in a dialog, so the worker fixes the code
        // (their new PIN is not lost to a code they already typed).
        final bool badOtp = f.code == AuthErrorCode.otpInvalid;
        setState(() => _phase = _Phase.otp);
        unawaited(_showErrorAlert(
          badOtp ? 'OTP sahi nahi' : 'Kuch gadbad ho gayi',
          authErrorMessage(f, 'hi'),
        ));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// The blue-header title for the current phase (the kit auth chrome carries
  /// the heading, so the phase bodies below start at the first control).
  String get _headerTitle => switch (_phase) {
        _Phase.phone => 'Apna number daalein',
        _Phase.otp => 'OTP daalein',
        _Phase.pin => 'Naya PIN banayein',
      };

  String get _headerSubtitle => switch (_phase) {
        _Phase.phone =>
          'Hum aapke number par OTP bhejenge — fir naya PIN bana sakte hain.',
        _Phase.otp => 'Number par aaya 6-digit OTP daalein.',
        _Phase.pin => 'Yeh naya PIN aapke purane PIN ko badal dega.',
      };

  @override
  Widget build(BuildContext context) {
    // Kit auth chrome: a full-bleed blue header (title/subtitle change per phase)
    // over the phase body. Pushed from enter-PIN, so a back affordance is shown.
    return Scaffold(
      body: Column(
        children: <Widget>[
          BbBlueHeader(
            title: _headerTitle,
            subtitle: _headerSubtitle,
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: switch (_phase) {
                _Phase.phone => _phoneView(),
                _Phase.otp => _otpView(),
                _Phase.pin => _pinView(),
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _phoneView() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s6,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('MOBILE NUMBER',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            style: AppTypography.mono(size: AppTypography.sizeLg),
            onChanged: (_) => setState(() {}), // repaint the CTA at 10 digits
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(kNationalNumberDigits),
            ],
            decoration: InputDecoration(
              prefixText: '$kIndiaDialCode ',
              prefixStyle: AppTypography.mono(size: AppTypography.sizeLg),
              hintText: 'XXXXXXXXXX',
            ),
          ),
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: 'Send OTP',
            block: true,
            loading: _busy,
            // Disabled until 10 digits — a half-typed number can only fail, and
            // a reset OTP is a real (billed) SMS.
            onPressed: _busy || !isCompleteNationalNumber(_phone.text)
                ? null
                : _sendReset,
          ),
        ],
      ),
    );
  }

  Widget _otpView() {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s6,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text('OTP DAALEIN',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s3),
          TextField(
            controller: _otp,
            keyboardType: TextInputType.number,
            textAlign: TextAlign.center,
            onChanged: (_) => setState(() {}), // enable the CTA when filled
            style: AppTypography.mono(
              size: AppTypography.size2xl,
              weight: FontWeight.w700,
              letterSpacing: 12,
            ),
            decoration: const InputDecoration(hintText: '— — — —'),
          ),
          const SizedBox(height: AppSpacing.s7),
          BbButton(
            label: 'Aage badhein',
            block: true,
            // Enabled once a code has been entered; the code is verified with the
            // new PIN at the final confirm.
            onPressed: _otp.text.trim().isEmpty ? null : _otpContinue,
          ),
        ],
      ),
    );
  }

  Widget _pinView() {
    // Pin-phase errors are centred dialogs (weak-PIN block, confirm mismatch),
    // so the body is just the two PIN rows. Scroll-safe: centred when there is
    // room, scrolls (never overflows) on a short screen.
    return BbScrollSafeBody(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
      child: Column(
        children: <Widget>[
          const Spacer(flex: 1),
          BbSetPinForm(
            key: _pinFormKey,
            enterLabel: 'NAYA PIN DAALEIN',
            confirmLabel: 'PIN DOBARA DAALEIN',
            busy: _busy,
            busyCaption: 'PIN set kar rahe hain…',
            onConfirmed: _confirmReset,
          ),
          const Spacer(flex: 2),
        ],
      ),
    );
  }
}
