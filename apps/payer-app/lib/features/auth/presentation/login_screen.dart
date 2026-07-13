import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/payer_auth_api.dart';
import '../../../core/auth/payer_token_store.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_field.dart';

/// Login — brand hero, a Company/Agency picker, an EMAIL field + "Get OTP" CTA
/// (step 1), then a 6-digit code-entry step (step 2), and the DPDP trust line.
///
/// EMAIL + OTP (not phone): the real payer API authenticates on email. The picked
/// role maps to the wire role at signup (`employer` | `agent`). On verify the
/// bearer is stored in [PayerTokenStore] and the session is set from the server's
/// [PayerLoginResult] (role is server-decided). In MOCK mode any email/code works
/// and routes the same.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

enum _Step { details, code }

class _LoginScreenState extends State<LoginScreen> {
  PayerRole _role = PayerRole.company;
  _Step _step = _Step.details;
  bool _busy = false;
  String? _error;

  final TextEditingController _org = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _code = TextEditingController();

  PayerAuthApi get _auth => locator<PayerAuthApi>();
  PayerTokenStore get _tokens => locator<PayerTokenStore>();

  @override
  void dispose() {
    _org.dispose();
    _email.dispose();
    _code.dispose();
    super.dispose();
  }

  /// Step 1: signup-or-request the email OTP for the picked role, then advance to
  /// the code step.
  Future<void> _requestOtp() async {
    final String org = _org.text.trim();
    final String email = _email.text.trim();
    if (org.isEmpty) {
      setState(() => _error = 'Enter your company or agency name to continue.');
      return;
    }
    if (email.isEmpty) {
      setState(() => _error = 'Enter your work email to get the code.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final String role = wireRoleFor(_role);
      // Mock mode remembers the picked role so verify echoes it back.
      final PayerAuthApi auth = _auth;
      if (auth is MockPayerAuthApi) auth.setRole(role);
      // signup is idempotent-ish on the server for an existing payer; either way
      // it (or login/request) sends the OTP. `org_name` is required by the
      // backend schema (min 1) for the new-payer path — an existing payer is a
      // no-overwrite 200, so passing the entered name is safe for both.
      await auth.signup(role: role, email: email, orgName: org);
      await auth.loginRequest(email: email);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _step = _Step.code;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Could not send the code. Check your network and retry.';
      });
    }
  }

  /// Step 2: verify the code, store the bearer, set the session from the result.
  Future<void> _verify() async {
    final String code = _code.text.trim();
    if (code.isEmpty) {
      setState(() => _error = 'Enter the code we sent to your email.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final PayerLoginResult result =
          await _auth.loginVerify(email: _email.text.trim(), code: code);
      if (result.accessToken.isEmpty) {
        if (!mounted) return;
        setState(() {
          _busy = false;
          _error = 'That code did not work. Try again.';
        });
        return;
      }
      await _tokens.save(
        accessToken: result.accessToken,
        payerId: result.payerId,
        role: result.role,
      );
      if (!mounted) return;
      await context.read<AppSessionCubit>().signInFromLogin(result);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Could not verify the code. Check your network and retry.';
      });
    }
  }

  void _editEmail() => setState(() {
        _step = _Step.details;
        _error = null;
        _code.clear();
      });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s6,
            AppSpacing.gutter,
            AppSpacing.s7,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: AppSpacing.s6),
              Center(
                child: Container(
                  width: 64,
                  height: 64,
                  decoration: BoxDecoration(
                    color: AppColors.brand,
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: <BoxShadow>[
                      BoxShadow(
                        color: AppColors.brand.withValues(alpha: 0.40),
                        blurRadius: 20,
                        offset: const Offset(0, 8),
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.handshake,
                    color: AppColors.textOnBrand,
                    size: 32,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.s5),
              Text(
                'Hire faster,\nbada bhai ke saath.',
                textAlign: TextAlign.center,
                style: AppTypography.display(
                  size: AppTypography.size2xl,
                  weight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: AppSpacing.s3),
              Text(
                'Post a job, browse verified candidates, unlock contact for ₹40. '
                'One login for companies and agencies.',
                textAlign: TextAlign.center,
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.s7),
              if (_step == _Step.details) ..._detailsStep() else ..._codeStep(),
              if (_error != null) ...<Widget>[
                const SizedBox(height: AppSpacing.s3),
                Text(
                  _error!,
                  textAlign: TextAlign.center,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.danger,
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.s3),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  const Icon(Icons.verified_user,
                      size: 14, color: AppColors.success),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      'DPDP-compliant · data stored in India. '
                      'By continuing you agree to our terms.',
                      textAlign: TextAlign.center,
                      style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        color: AppColors.textFaint,
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _detailsStep() => <Widget>[
        Text(
          'I am signing in as',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Row(
          children: <Widget>[
            Expanded(
              child: _RolePick(
                pickKey: const Key('pick_company'),
                icon: Icons.apartment,
                iconColor: AppColors.brandPress,
                title: 'Company',
                subtitle: 'Hire for your plant',
                selected: _role == PayerRole.company,
                onTap: () => setState(() => _role = PayerRole.company),
              ),
            ),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: _RolePick(
                pickKey: const Key('pick_agency'),
                icon: Icons.groups,
                iconColor: AppColors.saffronDeep,
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
          icon: Icons.apartment,
          keyboardType: TextInputType.text,
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Work email',
          controller: _email,
          fieldKey: const Key('email_field'),
          icon: Icons.mail_outline,
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Get OTP',
          buttonKey: const Key('get_otp'),
          iconRight: Icons.arrow_forward,
          block: true,
          loading: _busy,
          onPressed: _requestOtp,
        ),
      ];

  List<Widget> _codeStep() => <Widget>[
        Text(
          'Enter the code',
          style: AppTypography.display(
            size: AppTypography.sizeMd,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Text(
          'We sent a 6-digit code to ${_email.text.trim()}.',
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
          icon: Icons.lock_outline,
          keyboardType: TextInputType.number,
          mono: true,
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Verify & continue',
          buttonKey: const Key('verify_otp'),
          iconRight: Icons.arrow_forward,
          block: true,
          loading: _busy,
          onPressed: _verify,
        ),
        const SizedBox(height: AppSpacing.s2),
        BbButton(
          label: 'Change email',
          buttonKey: const Key('change_email'),
          variant: BbButtonVariant.ghost,
          size: BbButtonSize.md,
          block: true,
          onPressed: _busy ? null : _editEmail,
        ),
      ];
}

class _RolePick extends StatelessWidget {
  const _RolePick({
    required this.pickKey,
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });

  final Key pickKey;
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? AppColors.brandTint : AppColors.surfaceCard,
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: InkWell(
        key: pickKey,
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.s3),
          constraints: const BoxConstraints(minHeight: 92),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(
              color: selected ? AppColors.brand : AppColors.borderDefault,
              width: 2,
            ),
            boxShadow: selected
                ? <BoxShadow>[
                    BoxShadow(
                      color: AppColors.ring,
                      blurRadius: 0,
                      spreadRadius: 3,
                    ),
                  ]
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, size: 24, color: iconColor),
              const SizedBox(height: AppSpacing.s2),
              Text(
                title,
                style: AppTypography.display(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: AppTypography.body(
                  size: AppTypography.sizeXs,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
