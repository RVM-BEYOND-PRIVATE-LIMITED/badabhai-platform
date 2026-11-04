import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import 'auth_form_support.dart';

/// #2597 — one line of the set-new-password checklist. The first four mirror
/// the server's password policy (the server stays the authority); the last two
/// belong to the forced-change step.
enum NewPasswordRule {
  minLength('At least $kPasswordMinLength characters'),
  maxLength('At most $kPasswordMaxLength characters'),
  letter('At least one letter'),
  number('At least one number'),
  notTemporary('Not the temporary password'),
  confirmMatches('Both passwords match');

  const NewPasswordRule(this.label);

  /// The plain-English rule shown next to its tick.
  final String label;

  /// Whether [password] (and [confirm]) meet this rule. An empty password meets
  /// nothing, so no rule is ticked before the payer types.
  bool isMetBy({
    required String password,
    required String confirm,
    required String temporaryPassword,
  }) {
    if (password.isEmpty) return false;
    return switch (this) {
      NewPasswordRule.minLength => password.length >= kPasswordMinLength,
      NewPasswordRule.maxLength => password.length <= kPasswordMaxLength,
      NewPasswordRule.letter => passwordHasLetter(password),
      NewPasswordRule.number => passwordHasDigit(password),
      NewPasswordRule.notTemporary => password != temporaryPassword,
      NewPasswordRule.confirmMatches => confirm == password,
    };
  }
}

/// The key of [rule]'s row (tests + automation).
Key passwordRuleKey(NewPasswordRule rule) =>
    ValueKey<String>('password_rule_${rule.name}');

/// #2597 — password rules that tick off as each is met.
///
/// The tick morphs (fade + scale over [AppMotion.morph], the issue's 160ms) and
/// becomes an instant swap under reduced motion ([AppMotion.resolve]). The
/// state is in the shape too (a dot becomes a check), never colour alone, and a
/// screen reader hears one line per rule.
class PasswordRuleChecklist extends StatelessWidget {
  const PasswordRuleChecklist({
    super.key,
    required this.rules,
    required this.isMet,
  });

  final List<NewPasswordRule> rules;
  final bool Function(NewPasswordRule rule) isMet;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        for (final NewPasswordRule rule in rules)
          _PasswordRuleRow(rule: rule, met: isMet(rule)),
      ],
    );
  }
}

class _PasswordRuleRow extends StatelessWidget {
  const _PasswordRuleRow({required this.rule, required this.met});

  final NewPasswordRule rule;
  final bool met;

  /// The tick's box: the small "not yet" dot grows into the check inside it.
  static const double _tickBox = 18;
  static const double _dot = 10;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      key: passwordRuleKey(rule),
      container: true,
      label: '${rule.label}: ${met ? 'done' : 'not yet'}',
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.gap3),
          child: Row(
            children: <Widget>[
              SizedBox.square(
                dimension: _tickBox,
                child: AnimatedSwitcher(
                  duration: AppMotion.resolve(context, AppMotion.morph),
                  switchInCurve: AppMotion.easeOut,
                  // The out-curve is played backwards; flipping the ease-in
                  // token makes the leaving tick accelerate away in time.
                  switchOutCurve: AppMotion.easeIn.flipped,
                  transitionBuilder: _morph,
                  child: met
                      ? const Icon(
                          Icons.check_circle_rounded,
                          key: ValueKey<bool>(true),
                          size: _tickBox,
                          color: AppColors.blue,
                        )
                      : const Icon(
                          Icons.circle_rounded,
                          key: ValueKey<bool>(false),
                          size: _dot,
                          color: AppColors.textMuted,
                        ),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  rule.label,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textSecondary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Fade + a small scale (0.6 → 1 of an 18px tick: under 4px of travel).
  static Widget _morph(Widget child, Animation<double> animation) {
    return FadeTransition(
      opacity: animation,
      child: ScaleTransition(
        scale: Tween<double>(begin: 0.6, end: 1).animate(animation),
        child: child,
      ),
    );
  }
}
