import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/payer_auth_api.dart';
import '../../../core/auth/payer_token_store.dart';
import '../../../core/data/models.dart' show PayerApiException;
import '../../../core/di/locator.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_system_ui.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_logo.dart';
import '../../../core/widgets/bb_otp_input.dart';
import 'signup_screen.dart';
import 'widgets/auth_form_support.dart';
import 'widgets/set_new_password_step.dart';

/// Password sign-in + OTP fallback. The brand hero sits on top; below the form
/// the payer can open the full sign-up flow.
///
/// The primary path is `identifier + password`, where the identifier is a work
/// email, an E.164 phone, or the account's exact company/agency name. The OTP
/// path stays reachable for accounts created before passwords existed.
///
/// #2597 — a temporary password an admin issued (#2563) opens no session: the
/// [SetNewPasswordStep] slides in, and only the resend with a new password
/// signs the payer in. Code sign-in for such an account is refused (409) and
/// sends the payer to password sign-in.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

enum _LoginStep { login, otpContact, otpCode }

/// The sign-in that answered `password_change_required`, kept for the resend.
typedef _PasswordChange = ({String identifier, String temporaryPassword});

/// #2597 — the resend 401s when the temporary password no longer works — also
/// when an earlier resend already set the new one but its reply was lost.
const String _kResendRefusedHint =
    'If you already set a new password, sign in with it.';

/// #2597 — the new password is set, but this device could not finish signing in.
const String _kNewPasswordSetCopy = 'Your new password is set. Sign in with it.';

/// #2597 — the server asked for a new password again although one was sent.
/// Never a session; the payer can retry.
const String _kNewPasswordNotSavedCopy =
    "We couldn't save your new password. Please try again in a moment.";

class _LoginScreenState extends State<LoginScreen> {
  _LoginStep _step = _LoginStep.login;
  bool _busy = false;
  bool _obscurePassword = true;
  String? _error;

  /// Non-null ⇔ the set-new-password step is showing. Memory only — never
  /// logged or persisted — and dropped once the step succeeds or is left.
  _PasswordChange? _passwordChange;

  /// The server's reason the last new password was refused (inline on the step).
  String? _newPasswordError;

  final TextEditingController _identifier = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _otpContact = TextEditingController();
  final TextEditingController _code = TextEditingController();

  PayerAuthApi get _auth => locator<PayerAuthApi>();
  PayerTokenStore get _tokens => locator<PayerTokenStore>();

  @override
  void dispose() {
    _identifier.dispose();
    _password.dispose();
    _otpContact.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _signIn() async {
    final String identifier = normalizeIdentifier(_identifier.text);
    final String password = _password.text;
    if (identifier.isEmpty) {
      setState(() => _error = 'Enter your email, phone or company name.');
      return;
    }
    if (password.isEmpty) {
      setState(() => _error = 'Enter your password.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final PayerPasswordLoginOutcome outcome = await _auth.loginWithPassword(
        identifier: identifier,
        password: password,
      );
      switch (outcome) {
        case PayerPasswordSignedIn(:final PayerLoginResult session):
          await _storeAndSignIn(session);
        case PayerPasswordChangeRequired():
          // A temporary password proves the account but opens NO session.
          if (!mounted) return;
          setState(() {
            _busy = false;
            _passwordChange =
                (identifier: identifier, temporaryPassword: password);
            _newPasswordError = null;
          });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = authErrorFor(e);
      });
    }
  }

  /// #2597 — resends the temporary password with [newPassword]. Completes
  /// `true` only once a real session is stored and the payer is signed in.
  Future<bool> _submitNewPassword(String newPassword) async {
    final _PasswordChange? change = _passwordChange;
    if (change == null) return false;
    setState(() {
      _busy = true;
      _error = null;
      _newPasswordError = null;
    });
    bool passwordSet = false;
    try {
      final PayerPasswordLoginOutcome outcome = await _auth.loginWithPassword(
        identifier: change.identifier,
        password: change.temporaryPassword,
        newPassword: newPassword,
      );
      switch (outcome) {
        case PayerPasswordSignedIn(:final PayerLoginResult session):
          passwordSet = true;
          // From here on, exactly like a normal password sign-in. The step
          // stays up (spinner) until the shell replaces this screen.
          await _storeAndSignIn(session);
          if (!mounted) return true;
          // No rebuild needed: the shell takes over on the next frame.
          _forgetPasswordChange();
          if (context.read<AppSessionCubit>().isSignedIn) return true;
          // The session died while the identity resolved: the password is
          // set, so say so instead of leaving a spinner.
          _returnToSignIn(_kNewPasswordSetCopy);
          return false;
        case PayerPasswordChangeRequired():
          if (!mounted) return false;
          setState(() {
            _busy = false;
            _error = _kNewPasswordNotSavedCopy;
          });
          return false;
      }
    } catch (e) {
      if (!mounted) return false;
      if (passwordSet) {
        _returnToSignIn(_kNewPasswordSetCopy);
      } else if (e is PayerApiException && e.statusCode == 401) {
        // The temporary password no longer opens the account: back to the
        // start, with the same neutral copy as any refused sign-in.
        _returnToSignIn('${authErrorFor(e)} $_kResendRefusedHint');
      } else if (e is PayerApiException && e.statusCode == 400) {
        setState(() {
          _busy = false;
          _newPasswordError = _newPasswordRejectionCopy(e);
        });
      } else {
        setState(() {
          _busy = false;
          _error = authErrorFor(e);
        });
      }
      return false;
    }
  }

  /// The inline copy for a refused new password: the server's own reason (it
  /// is the policy authority) or, without one, the generic 400 line.
  static String _newPasswordRejectionCopy(PayerApiException e) {
    final String? reason = e.validationMessage?.trim();
    if (reason == null || reason.isEmpty) return authErrorFor(e);
    return reason.endsWith('.') ? reason : '$reason.';
  }

  /// Drops the temporary password from memory (the field and the resend copy).
  void _forgetPasswordChange() {
    _passwordChange = null;
    _password.clear();
  }

  /// Leaves the set-new-password step for password sign-in, showing [message].
  void _returnToSignIn(String? message) => setState(() {
        _forgetPasswordChange();
        _busy = false;
        _newPasswordError = null;
        _error = message;
        _step = _LoginStep.login;
      });

  void _clearNewPasswordError() {
    if (_newPasswordError != null) setState(() => _newPasswordError = null);
  }

  Future<void> _requestOtp() async {
    final ContactParts? contact = parseContact(_otpContact.text);
    if (contact == null) {
      setState(() => _error = 'Enter a work email or a 10-digit phone number.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _auth.loginRequest(email: contact.email, phone: contact.phone);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _step = _LoginStep.otpCode;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = authErrorFor(e, otp: true);
      });
    }
  }

  Future<void> _verifyOtp() async {
    // #2595 — one verify at a time. The boxes submit on their last digit and
    // the button by hand; whichever comes second while a verify runs is
    // dropped, so one code is never sent twice (each try counts against the
    // attempt cap).
    if (_busy) return;
    final String code = _code.text.trim();
    if (code.isEmpty) {
      setState(() => _error = 'Enter the code we sent you.');
      return;
    }
    final ContactParts? contact = parseContact(_otpContact.text);
    if (contact == null) {
      setState(() => _error = 'Go back and enter a valid email or phone.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final PayerLoginResult result = await _auth.loginVerify(
        email: contact.email,
        phone: contact.phone,
        code: code,
      );
      if (result.accessToken.isEmpty) {
        if (!mounted) return;
        _failVerify('That code did not work. Try again.');
        return;
      }
      await _storeAndSignIn(result);
    } on PayerPasswordChangeRequiredException catch (e) {
      // #2597 — a temporary-password account cannot use the code door: send
      // the payer to password sign-in, with the contact they just proved.
      if (!mounted) return;
      setState(() {
        _busy = false;
        _code.clear();
        if (_identifier.text.trim().isEmpty) {
          _identifier.text = _otpContact.text.trim();
        }
        _error = authErrorFor(e, otp: true);
        _step = _LoginStep.login;
      });
    } catch (e) {
      if (!mounted) return;
      _failVerify(authErrorFor(e, otp: true));
    }
  }

  /// #2595 — a verify that did not sign the payer in: [message] shows and the
  /// boxes empty, which re-arms their auto-submit — the same code typed again
  /// submits again.
  void _failVerify(String message) => setState(() {
        _busy = false;
        _code.clear();
        _error = message;
      });

  Future<void> _storeAndSignIn(PayerLoginResult result) async {
    await _tokens.save(
      accessToken: result.accessToken,
      payerId: result.payerId,
      role: result.role,
    );
    if (!mounted) return;
    await context.read<AppSessionCubit>().signInFromLogin(result);
  }

  void _openSignup() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const SignupScreen()),
    );
  }

  void _openOtpLogin() => setState(() {
        _step = _LoginStep.otpContact;
        _error = null;
      });

  void _backToLogin() => setState(() {
        _step = _LoginStep.login;
        _error = null;
        _code.clear();
      });

  @override
  Widget build(BuildContext context) {
    final _PasswordChange? change = _passwordChange;
    return Scaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const _BrandHeader(),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                AppSpacing.s6,
                AppSpacing.gutter,
                AppSpacing.s7,
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: AppSpacing.appMax),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      NewPasswordStepSwitcher(
                        child: change == null
                            ? BbAnimatedSwitcher(
                                key: const ValueKey<String>('sign_in_steps'),
                                child: Column(
                                  key: ValueKey<_LoginStep>(_step),
                                  crossAxisAlignment: CrossAxisAlignment.stretch,
                                  mainAxisSize: MainAxisSize.min,
                                  children: switch (_step) {
                                    _LoginStep.login => _loginStep(),
                                    _LoginStep.otpContact => _otpContactStep(),
                                    _LoginStep.otpCode => _otpCodeStep(),
                                  },
                                ),
                              )
                            : _newPasswordStep(change),
                      ),
                      if (_error != null) ...<Widget>[
                        const SizedBox(height: AppSpacing.s3),
                        AuthErrorLine(message: _error!),
                      ],
                      const SizedBox(height: AppSpacing.s4),
                      const AuthTrustLine(),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// #2597 — the forced change. System Back returns to sign-in (abandoning the
  /// step) instead of leaving the app with a half-done change.
  Widget _newPasswordStep(_PasswordChange change) => PopScope(
        key: const ValueKey<String>('set_new_password_step'),
        canPop: false,
        onPopInvokedWithResult: (bool didPop, Object? result) {
          if (!didPop && !_busy && _passwordChange != null) {
            _returnToSignIn(null);
          }
        },
        child: SetNewPasswordStep(
          temporaryPassword: change.temporaryPassword,
          busy: _busy,
          serverError: _newPasswordError,
          onEdited: _clearNewPasswordError,
          onSubmit: _submitNewPassword,
          onBack: () => _returnToSignIn(null),
        ),
      );

  List<Widget> _loginStep() => <Widget>[
        Text(
          'Welcome back',
          style: AppTypography.heading(
            size: AppTypography.sizeLg,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'Sign in with your password.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: AppSpacing.s5),
        BbField(
          label: 'Email, phone or company name',
          controller: _identifier,
          fieldKey: const Key('login_identifier'),
          icon: Icons.person_rounded,
          keyboardType: TextInputType.emailAddress,
          suppressSuggestions: true,
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Password',
          controller: _password,
          fieldKey: const Key('login_password'),
          icon: Icons.lock_rounded,
          obscureText: _obscurePassword,
          suppressSuggestions: true,
          suffixIcon: AuthEyeToggle(
            obscured: _obscurePassword,
            onPressed: () =>
                setState(() => _obscurePassword = !_obscurePassword),
          ),
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Sign in',
          buttonKey: const Key('login_button'),
          iconRight: Icons.arrow_forward_rounded,
          block: true,
          loading: _busy,
          onPressed: _signIn,
        ),
        const SizedBox(height: AppSpacing.s4),
        BbButton(
          label: 'New user? Create account',
          buttonKey: const Key('signup_open'),
          variant: BbButtonVariant.secondary,
          size: BbButtonSize.md,
          block: true,
          onPressed: _busy ? null : _openSignup,
        ),
        const SizedBox(height: AppSpacing.s1),
        BbButton(
          label: 'Login with OTP instead',
          buttonKey: const Key('otp_login_open'),
          variant: BbButtonVariant.ghost,
          size: BbButtonSize.md,
          block: true,
          onPressed: _busy ? null : _openOtpLogin,
        ),
      ];

  List<Widget> _otpContactStep() => <Widget>[
        Text(
          'Login with OTP',
          style: AppTypography.heading(
            size: AppTypography.sizeLg,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'We will send a one-time code to your email or phone.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: AppSpacing.s5),
        BbField(
          label: 'Work email or phone',
          controller: _otpContact,
          fieldKey: const Key('otp_contact_field'),
          icon: Icons.mail_rounded,
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Get OTP',
          buttonKey: const Key('otp_get_code'),
          iconRight: Icons.arrow_forward_rounded,
          block: true,
          loading: _busy,
          onPressed: _requestOtp,
        ),
        const SizedBox(height: AppSpacing.s1),
        BbButton(
          label: 'Back to password sign in',
          buttonKey: const Key('otp_back'),
          variant: BbButtonVariant.ghost,
          size: BbButtonSize.md,
          block: true,
          onPressed: _busy ? null : _backToLogin,
        ),
      ];

  List<Widget> _otpCodeStep() => <Widget>[
        Text(
          'Enter the code',
          style: AppTypography.heading(
            size: AppTypography.sizeLg,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'We sent a 6-digit code to ${_otpContact.text.trim()}.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        // #2595 — six boxes. The last digit (typed, pasted or autofilled from
        // the SMS) submits through the same verify as the button below, which
        // stays for a payer who taps.
        BbOtpInput(
          controller: _code,
          fieldKey: const Key('otp_code_field'),
          semanticLabel: 'OTP code',
          onCompleted: (_) => _verifyOtp(),
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Verify & continue',
          buttonKey: const Key('otp_verify'),
          iconRight: Icons.arrow_forward_rounded,
          block: true,
          loading: _busy,
          onPressed: _verifyOtp,
        ),
        const SizedBox(height: AppSpacing.s1),
        BbButton(
          label: 'Change email or phone',
          buttonKey: const Key('otp_change_contact'),
          variant: BbButtonVariant.ghost,
          size: BbButtonSize.md,
          block: true,
          onPressed: _busy ? null : _openOtpLogin,
        ),
      ];
}

/// Blue band: haldi mark IN LINE with the headline (one horizontal row).
class _BrandHeader extends StatelessWidget {
  const _BrandHeader();

  @override
  Widget build(BuildContext context) {
    // #2590 — the blue band runs under the status bar: light icons on it.
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: AppSystemUi.onDark,
      child: Container(
        width: double.infinity,
        color: AppColors.blue,
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s5,
              AppSpacing.gutter,
              AppSpacing.s5,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: <Widget>[
                // #2590 — the real BadaBhai mark, not a stock handshake icon.
                const BbLogo.onBlue(size: AppSpacing.brandMark),
                const SizedBox(width: AppSpacing.s4),
                Expanded(
                  child: Text(
                    'Hire faster,\nbada bhai ke saath.',
                    style: AppTypography.header(
                      size: AppTypography.sizeXl,
                      weight: FontWeight.w800,
                      color: AppColors.onBlue,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
