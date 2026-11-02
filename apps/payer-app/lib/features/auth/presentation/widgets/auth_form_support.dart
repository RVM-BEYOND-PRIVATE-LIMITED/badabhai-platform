import 'package:flutter/material.dart';

import '../../../../core/data/models.dart' show PayerApiException;
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/phone_format.dart';

/// Shared pieces of the payer auth forms (login + sign-up): contact parsing,
/// the password policy mirror, one honest error mapper, and the small widgets
/// both screens draw.

/// Email or E.164 phone, exactly one set.
typedef ContactParts = ({String? email, String? phone});

/// Parse a single "email or phone" input into the wire contact shape.
///
/// Anything with `@` is treated as an email; anything else must reduce to a
/// 10-digit Indian mobile and is sent as E.164 (`+91…`). Null = invalid.
ContactParts? parseContact(String raw) {
  final String value = raw.trim();
  if (value.isEmpty) return null;
  if (value.contains('@')) return (email: value, phone: null);
  final String? phone = normalizeIndianMobileToE164(value);
  if (phone == null) return null;
  return (email: null, phone: phone);
}

/// Birthday of the login identifier: an email is trimmed, a phone-looking value
/// is normalized to E.164 (so `89469 91002` matches the stored `+918946991002`),
/// and an exact company name passes through untouched.
String normalizeIdentifier(String raw) {
  final String value = raw.trim();
  if (value.contains('@')) return value;
  return normalizeIndianMobileToE164(value) ?? value;
}

/// The client mirror of the server's password policy (the server is the
/// authority): 8–128 chars, at least one letter and one digit.
String? passwordPolicyProblem(String password) {
  if (password.length < 8) return 'Use at least 8 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (!RegExp('[A-Za-z]').hasMatch(password)) return 'Add at least one letter.';
  if (!RegExp(r'\d').hasMatch(password)) return 'Add at least one number.';
  return null;
}

/// One honest reason for a failed auth call — never "wrong password" for a
/// 429/5xx, and never a network blame for a rejected credential.
String authErrorFor(Object e, {bool otp = false}) {
  if (e is PayerApiException) {
    if (e.statusCode == 401) {
      return 'Wrong email, phone or company name, or password.';
    }
    if (e.statusCode == 429) {
      return 'Too many attempts. Please wait a minute and try again.';
    }
    if (e.statusCode == 400) {
      return 'Please check the details and try again.';
    }
    if (e.statusCode >= 500) {
      return otp
          ? "We couldn't send your code right now. Please try again in a moment."
          : "We couldn't complete that right now. Please try again in a moment.";
    }
    return otp
        ? "We couldn't send your code. Please check your details and try again."
        : "We couldn't complete that. Please check your details and try again.";
  }
  return 'Could not reach the server. Check your connection and retry.';
}

/// Role choice card (Company / Agency).
class AuthRolePick extends StatelessWidget {
  const AuthRolePick({
    super.key,
    required this.pickKey,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });

  final Key pickKey;
  final IconData icon;
  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        key: pickKey,
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.s3),
          decoration: BoxDecoration(
            color: selected ? AppColors.haldiTint : AppColors.canvas,
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(
              color: selected ? AppColors.haldi : AppColors.borderDefault,
              width: selected ? 2 : 1,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(icon, size: 22, color: AppColors.textBrand),
              const SizedBox(height: AppSpacing.s2),
              Text(
                title,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: AppSpacing.gap2),
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

/// Eye toggle for password fields.
class AuthEyeToggle extends StatelessWidget {
  const AuthEyeToggle({super.key, required this.obscured, required this.onPressed});

  final bool obscured;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: onPressed,
      icon: Icon(
        obscured ? Icons.visibility_outlined : Icons.visibility_off_outlined,
        size: 20,
        color: AppColors.textMuted,
      ),
      tooltip: obscured ? 'Show password' : 'Hide password',
    );
  }
}

/// The DPDP trust line.
class AuthTrustLine extends StatelessWidget {
  const AuthTrustLine({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        const Icon(Icons.verified_user, size: 16, color: AppColors.success),
        const SizedBox(width: AppSpacing.s2),
        Expanded(
          child: Text(
            'DPDP-compliant · data stored in India. '
            'By continuing you agree to our terms.',
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
        ),
      ],
    );
  }
}

/// A failure line — red only, states what happened.
class AuthErrorLine extends StatelessWidget {
  const AuthErrorLine({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s3,
        vertical: AppSpacing.s3,
      ),
      decoration: BoxDecoration(
        color: AppColors.dangerTint,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: AppColors.red100),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.error_outline, size: 16, color: AppColors.danger),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              message,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.danger,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
