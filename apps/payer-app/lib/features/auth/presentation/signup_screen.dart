import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/payer_auth_api.dart';
import '../../../core/auth/payer_token_store.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_system_ui.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_field.dart';
import 'widgets/auth_form_support.dart';

/// The sign-up flow: role → company name → email/phone → OTP → password.
///
/// The OTP-verify token is held in memory ONLY until the password is set, so a
/// payer who abandons on the password step is not left signed in. Backend
/// contract: issue #2497.
class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key});

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

enum _SignupStep { details, code, password }

class _SignupScreenState extends State<SignupScreen> {
  _SignupStep _step = _SignupStep.details;
  PayerRole _role = PayerRole.company;
  bool _busy = false;
  bool _obscurePassword = true;
  bool _obscureConfirm = true;
  String? _error;

  final TextEditingController _org = TextEditingController();
  final TextEditingController _contact = TextEditingController();
  final TextEditingController _code = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _confirm = TextEditingController();

  /// The session minted by OTP verify — NOT persisted until the password is set.
  PayerLoginResult? _pendingSession;

  PayerAuthApi get _auth => locator<PayerAuthApi>();
  PayerTokenStore get _tokens => locator<PayerTokenStore>();

  @override
  void dispose() {
    _org.dispose();
    _contact.dispose();
    _code.dispose();
    _password.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _requestOtp() async {
    final String org = _org.text.trim();
    final ContactParts? contact = parseContact(_contact.text);
    if (org.isEmpty) {
      setState(() => _error = 'Enter your company or agency name.');
      return;
    }
    if (contact == null) {
      setState(() => _error = 'Enter a work email or a 10-digit phone number.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _auth.signup(
        role: wireRoleFor(_role),
        orgName: org,
        email: contact.email,
        phone: contact.phone,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _step = _SignupStep.code;
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
    final ContactParts? contact = parseContact(_contact.text);
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
      if (!mounted) return;
      setState(() {
        _busy = false;
        _pendingSession = result;
        _step = _SignupStep.password;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = authErrorFor(e, otp: true);
      });
    }
  }

  Future<void> _createProfile() async {
    final PayerLoginResult? pending = _pendingSession;
    if (pending == null) {
      setState(() {
        _step = _SignupStep.details;
        _error = 'Verify your email or phone again.';
      });
      return;
    }
    final String password = _password.text;
    final String confirm = _confirm.text;
    final String? problem = passwordPolicyProblem(password);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    if (password != confirm) {
      setState(() => _error = 'Passwords do not match.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _auth.setPassword(
        accessToken: pending.accessToken,
        password: password,
      );
      await _tokens.save(
        accessToken: pending.accessToken,
        payerId: pending.payerId,
        role: pending.role,
      );
      if (!mounted) return;
      final AppSessionCubit session = context.read<AppSessionCubit>();
      Navigator.of(context).popUntil((Route<dynamic> r) => r.isFirst);
      await session.signInFromLogin(pending);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = authErrorFor(e);
      });
    }
  }

  void _back() {
    if (_step == _SignupStep.details) {
      Navigator.of(context).maybePop();
      return;
    }
    setState(() {
      _error = null;
      _pendingSession = null;
      _step =
          _step == _SignupStep.password ? _SignupStep.code : _SignupStep.details;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _SignupTopBar(onBack: _busy ? null : _back),
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
                          key: ValueKey<_SignupStep>(_step),
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          mainAxisSize: MainAxisSize.min,
                          children: switch (_step) {
                            _SignupStep.details => _detailsStep(),
                            _SignupStep.code => _codeStep(),
                            _SignupStep.password => _passwordStep(),
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

  List<Widget> _detailsStep() => <Widget>[
        Text(
          'Create your account',
          style: AppTypography.heading(
            size: AppTypography.sizeLg,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'I am signing in as',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s3),
        Row(
          children: <Widget>[
            Expanded(
              child: AuthRolePick(
                pickKey: const Key('pick_company'),
                icon: Icons.apartment_rounded,
                title: 'Company',
                subtitle: 'Hire for your plant',
                selected: _role == PayerRole.company,
                onTap: () => setState(() => _role = PayerRole.company),
              ),
            ),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: AuthRolePick(
                pickKey: const Key('pick_agency'),
                icon: Icons.groups_rounded,
                title: 'Agency',
                subtitle: 'Hire + earn on supply',
                selected: _role == PayerRole.agency,
                onTap: () => setState(() => _role = PayerRole.agency),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s5),
        BbField(
          label: _role == PayerRole.agency ? 'Agency name' : 'Company name',
          controller: _org,
          fieldKey: const Key('org_field'),
          icon: Icons.apartment_rounded,
          keyboardType: TextInputType.text,
          suppressSuggestions: true,
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Work email or phone',
          controller: _contact,
          fieldKey: const Key('contact_field'),
          icon: Icons.mail_rounded,
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Get OTP',
          buttonKey: const Key('get_otp'),
          iconRight: Icons.arrow_forward_rounded,
          block: true,
          loading: _busy,
          onPressed: _requestOtp,
        ),
      ];

  List<Widget> _codeStep() => <Widget>[
        Text(
          'Enter the code',
          style: AppTypography.heading(
            size: AppTypography.sizeLg,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'We sent a 6-digit code to ${_contact.text.trim()}.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'OTP code',
          controller: _code,
          fieldKey: const Key('code_field'),
          icon: Icons.lock_rounded,
          keyboardType: TextInputType.number,
          mono: true,
          autofillHints: const <String>[AutofillHints.oneTimeCode],
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Verify code',
          buttonKey: const Key('verify_otp'),
          iconRight: Icons.arrow_forward_rounded,
          block: true,
          loading: _busy,
          onPressed: _verifyOtp,
        ),
        const SizedBox(height: AppSpacing.s1),
        BbButton(
          label: 'Change email or phone',
          buttonKey: const Key('signup_change_contact'),
          variant: BbButtonVariant.ghost,
          size: BbButtonSize.md,
          block: true,
          onPressed: _busy ? null : _back,
        ),
      ];

  List<Widget> _passwordStep() => <Widget>[
        Text(
          'Create your password',
          style: AppTypography.heading(
            size: AppTypography.sizeLg,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'Use at least 8 characters with one letter and one number.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textSecondary,
          ),
        ),
        const SizedBox(height: AppSpacing.s5),
        BbField(
          label: 'Password',
          controller: _password,
          fieldKey: const Key('signup_password'),
          icon: Icons.lock_rounded,
          obscureText: _obscurePassword,
          suppressSuggestions: true,
          suffixIcon: AuthEyeToggle(
            obscured: _obscurePassword,
            onPressed: () =>
                setState(() => _obscurePassword = !_obscurePassword),
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Confirm password',
          controller: _confirm,
          fieldKey: const Key('signup_confirm'),
          icon: Icons.lock_rounded,
          obscureText: _obscureConfirm,
          suppressSuggestions: true,
          suffixIcon: AuthEyeToggle(
            obscured: _obscureConfirm,
            onPressed: () => setState(() => _obscureConfirm = !_obscureConfirm),
          ),
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Create profile',
          buttonKey: const Key('create_profile'),
          iconRight: Icons.check_rounded,
          block: true,
          loading: _busy,
          onPressed: _createProfile,
        ),
      ];
}

/// Compact blue top bar for sign-up (back + title).
class _SignupTopBar extends StatelessWidget {
  const _SignupTopBar({this.onBack});

  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    // #2590 — the blue bar runs under the status bar: light icons on it (the
    // app-wide fallback would otherwise give it the light canvas's dark icons).
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: AppSystemUi.onDark,
      child: Container(
        width: double.infinity,
        color: AppColors.blue,
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.s2,
              AppSpacing.s2,
              AppSpacing.gutter,
              AppSpacing.s2,
            ),
            child: Row(
              children: <Widget>[
                IconButton(
                  onPressed: onBack,
                  icon: const Icon(Icons.arrow_back_rounded,
                      color: AppColors.onBlue),
                  tooltip: 'Back',
                ),
                const SizedBox(width: AppSpacing.s1),
                Text(
                  'Sign up',
                  style: AppTypography.header(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                    color: AppColors.onBlue,
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
