import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/payer_auth_api.dart';
import '../../../core/auth/payer_token_store.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_field.dart';
import 'signup_screen.dart';
import 'widgets/auth_form_support.dart';

/// Password sign-in + OTP fallback. The brand hero sits on top; below the form
/// the payer can open the full sign-up flow.
///
/// The primary path is `identifier + password`, where the identifier is a work
/// email, an E.164 phone, or the account's exact company/agency name. The OTP
/// path stays reachable for accounts created before passwords existed.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

enum _LoginStep { login, otpContact, otpCode }

class _LoginScreenState extends State<LoginScreen> {
  _LoginStep _step = _LoginStep.login;
  bool _busy = false;
  bool _obscurePassword = true;
  String? _error;

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
      final PayerLoginResult result = await _auth.loginWithPassword(
        identifier: identifier,
        password: password,
      );
      await _storeAndSignIn(result);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = authErrorFor(e);
      });
    }
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
        setState(() {
          _busy = false;
          _error = 'That code did not work. Try again.';
        });
        return;
      }
      await _storeAndSignIn(result);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = authErrorFor(e, otp: true);
      });
    }
  }

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
                      BbAnimatedSwitcher(
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
          icon: Icons.person_outline,
          keyboardType: TextInputType.emailAddress,
          suppressSuggestions: true,
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Password',
          controller: _password,
          fieldKey: const Key('login_password'),
          icon: Icons.lock_outline,
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
          iconRight: Icons.arrow_forward,
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
          icon: Icons.mail_outline,
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Get OTP',
          buttonKey: const Key('otp_get_code'),
          iconRight: Icons.arrow_forward,
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
        BbField(
          label: 'OTP code',
          controller: _code,
          fieldKey: const Key('otp_code_field'),
          icon: Icons.lock_outline,
          keyboardType: TextInputType.number,
          mono: true,
          autofillHints: const <String>[AutofillHints.oneTimeCode],
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Verify & continue',
          buttonKey: const Key('otp_verify'),
          iconRight: Icons.arrow_forward,
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
    return Container(
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
              Container(
                width: AppSpacing.brandMark,
                height: AppSpacing.brandMark,
                decoration: BoxDecoration(
                  color: AppColors.haldi,
                  borderRadius: BorderRadius.circular(AppRadii.xl),
                ),
                child: const Icon(
                  Icons.handshake,
                  color: AppColors.onHaldi,
                  size: 30,
                ),
              ),
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
    );
  }
}
