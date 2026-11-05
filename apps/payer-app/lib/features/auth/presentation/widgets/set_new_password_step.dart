import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInput;

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_field.dart';
import 'auth_form_support.dart';
import 'password_rules.dart';

/// The slide's travel — the 6px motion ceiling.
const double _kStepTravel = 6;

/// The rules under the new-password field; the match rule sits under confirm.
const List<NewPasswordRule> _kNewPasswordRules = <NewPasswordRule>[
  NewPasswordRule.minLength,
  NewPasswordRule.maxLength,
  NewPasswordRule.letter,
  NewPasswordRule.number,
  NewPasswordRule.notTemporary,
];

const String _kNotTemporaryCopy =
    'Choose a different password. It cannot be the temporary one.';
const String _kMismatchCopy = 'Passwords do not match.';

/// #2597 — the step shown when password sign-in answered
/// `password_change_required`: the payer holds a temporary password an admin
/// issued (backend #2563) and must choose their own before any session exists.
///
/// The new password lives ONLY in this widget's controllers — never logged,
/// never persisted — and is cleared once the payer is signed in and on dispose
/// (leaving the step). The rules tick off as they are met; the server stays the
/// policy authority, so its 400 reason ([serverError]) shows inline on the
/// new-password field.
///
/// Both fields are one OS autofill context ([AutofillHints.newPassword]), so a
/// password manager can suggest a strong password. That context is committed —
/// the OS may offer to save — only once the payer is signed in; leaving the
/// step any other way cancels it, so a password the server never accepted is
/// never offered for saving.
class SetNewPasswordStep extends StatefulWidget {
  const SetNewPasswordStep({
    super.key,
    required this.temporaryPassword,
    required this.busy,
    required this.onSubmit,
    required this.onBack,
    this.serverError,
    this.onEdited,
  });

  /// The temporary password just used — only for the "not the temporary
  /// password" rule. Held in memory by the caller for the resend.
  final String temporaryPassword;

  /// A request is in flight: the CTA spins and Back is disabled.
  final bool busy;

  /// Sends a new password that passes every rule. Completes `true` once the
  /// payer is signed in, `false` when the step stays up or has been left.
  final Future<bool> Function(String newPassword) onSubmit;

  /// Back to sign-in — abandons the step.
  final VoidCallback onBack;

  /// The server's reason the last new password was refused, if any.
  final String? serverError;

  /// The new password was edited — any [serverError] is now stale.
  final VoidCallback? onEdited;

  @override
  State<SetNewPasswordStep> createState() => _SetNewPasswordStepState();
}

class _SetNewPasswordStepState extends State<SetNewPasswordStep> {
  final TextEditingController _newPassword = TextEditingController();
  final TextEditingController _confirm = TextEditingController();
  final FocusNode _newFocus = FocusNode();
  final FocusNode _confirmFocus = FocusNode();
  bool _obscureNew = true;
  bool _obscureConfirm = true;
  String? _newError;
  String? _confirmError;

  @override
  void initState() {
    super.initState();
    // Typing is the only thing to do here: focus the field once laid out.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _newFocus.requestFocus();
    });
  }

  @override
  void didUpdateWidget(SetNewPasswordStep oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A fresh server refusal: put the payer back on the field it is about.
    if (widget.serverError != null &&
        widget.serverError != oldWidget.serverError) {
      _newFocus.requestFocus();
    }
  }

  @override
  void dispose() {
    // Leaving the step abandons it: drop the passwords before release.
    _newPassword.clear();
    _confirm.clear();
    _newPassword.dispose();
    _confirm.dispose();
    _newFocus.dispose();
    _confirmFocus.dispose();
    super.dispose();
  }

  bool _isMet(NewPasswordRule rule) => rule.isMetBy(
        password: _newPassword.text,
        confirm: _confirm.text,
        temporaryPassword: widget.temporaryPassword,
      );

  void _onNewPasswordEdited() {
    setState(() => _newError = null);
    widget.onEdited?.call();
  }

  void _onConfirmEdited() => setState(() => _confirmError = null);

  Future<void> _submit() async {
    if (widget.busy) return;
    final String password = _newPassword.text;
    final String? problem = passwordPolicyProblem(password) ??
        (password == widget.temporaryPassword ? _kNotTemporaryCopy : null);
    if (problem != null) {
      setState(() {
        _newError = problem;
        _confirmError = null;
      });
      _newFocus.requestFocus();
      return;
    }
    if (_confirm.text != password) {
      setState(() {
        _newError = null;
        _confirmError = _kMismatchCopy;
      });
      _confirmFocus.requestFocus();
      return;
    }
    setState(() {
      _newError = null;
      _confirmError = null;
    });
    final bool signedIn = await widget.onSubmit(password);
    // Signed in: the shell replaces this screen on the next frame, so the
    // passwords go now rather than waiting for dispose. The autofill context
    // is committed first, while it still holds the accepted password.
    if (signedIn && mounted) {
      TextInput.finishAutofillContext();
      _newPassword.clear();
      _confirm.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    // One autofill context for the pair (see the class doc). Cancel on
    // dispose: only a sign-in commits it ([_submit]).
    return AutofillGroup(
      onDisposeAction: AutofillContextAction.cancel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            'Set a new password',
            style: AppTypography.heading(
              size: AppTypography.sizeLg,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'Your password is temporary. Choose a new one to continue.',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          BbField(
            label: 'New password',
            controller: _newPassword,
            fieldKey: const Key('new_password_field'),
            icon: Icons.lock_rounded,
            obscureText: _obscureNew,
            suppressSuggestions: true,
            autofillHints: const <String>[AutofillHints.newPassword],
            focusNode: _newFocus,
            textInputAction: TextInputAction.next,
            onSubmitted: (_) => _confirmFocus.requestFocus(),
            onChanged: (_) => _onNewPasswordEdited(),
            errorText: _newError ?? widget.serverError,
            suffixIcon: AuthEyeToggle(
              obscured: _obscureNew,
              onPressed: () => setState(() => _obscureNew = !_obscureNew),
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          PasswordRuleChecklist(rules: _kNewPasswordRules, isMet: _isMet),
          const SizedBox(height: AppSpacing.s4),
          BbField(
            label: 'Confirm new password',
            controller: _confirm,
            fieldKey: const Key('new_password_confirm'),
            icon: Icons.lock_rounded,
            obscureText: _obscureConfirm,
            suppressSuggestions: true,
            autofillHints: const <String>[AutofillHints.newPassword],
            focusNode: _confirmFocus,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
            onChanged: (_) => _onConfirmEdited(),
            errorText: _confirmError,
            suffixIcon: AuthEyeToggle(
              obscured: _obscureConfirm,
              onPressed: () =>
                  setState(() => _obscureConfirm = !_obscureConfirm),
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          PasswordRuleChecklist(
            rules: const <NewPasswordRule>[NewPasswordRule.confirmMatches],
            isMet: _isMet,
          ),
          const SizedBox(height: AppSpacing.s5),
          BbButton(
            label: 'Save new password',
            buttonKey: const Key('new_password_submit'),
            iconRight: Icons.check_rounded,
            block: true,
            loading: widget.busy,
            onPressed: _submit,
          ),
          const SizedBox(height: AppSpacing.s1),
          BbButton(
            label: 'Back to sign in',
            buttonKey: const Key('new_password_back'),
            variant: BbButtonVariant.ghost,
            size: BbButtonSize.md,
            block: true,
            onPressed: widget.busy ? null : widget.onBack,
          ),
        ],
      ),
    );
  }
}

/// #2597 — swaps the sign-in steps for [SetNewPasswordStep] and back: a fade
/// plus a 6px rise over [AppMotion.page] (the issue's 300ms) on the shared
/// ease-out, while the side that leaves fades and sinks over [AppMotion.fast]
/// on an ease-in. Only opacity and transform animate, input is never held back,
/// and reduced motion makes the swap instant ([AppMotion.resolve]). Give each
/// side its own [Key].
class NewPasswordStepSwitcher extends StatelessWidget {
  const NewPasswordStepSwitcher({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: AppMotion.resolve(context, AppMotion.page),
      reverseDuration: AppMotion.resolve(context, AppMotion.fast),
      switchInCurve: AppMotion.easeOut,
      // The out-curve is played backwards; flipping the ease-in token makes the
      // leaving side accelerate away in time — a true ease-in exit.
      switchOutCurve: AppMotion.easeIn.flipped,
      layoutBuilder: _topAligned,
      transitionBuilder: _slideIn,
      child: child,
    );
  }

  /// Top-aligned so the taller side grows downward instead of re-centring.
  static Widget _topAligned(Widget? current, List<Widget> previous) {
    return Stack(
      alignment: Alignment.topCenter,
      children: <Widget>[...previous, if (current != null) current],
    );
  }

  static Widget _slideIn(Widget child, Animation<double> animation) {
    return FadeTransition(
      opacity: animation,
      child: AnimatedBuilder(
        animation: animation,
        builder: (BuildContext context, Widget? child) => Transform.translate(
          offset: Offset(0, _kStepTravel * (1 - animation.value)),
          child: child,
        ),
        child: child,
      ),
    );
  }
}
