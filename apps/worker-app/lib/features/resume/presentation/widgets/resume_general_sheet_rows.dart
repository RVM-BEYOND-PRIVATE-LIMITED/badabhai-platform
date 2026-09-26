/// #1736 — the general sheet's row primitives, in one file.
///
/// They live apart from both views because BOTH draw them: the sheet view draws
/// its sections out of them, and `ResumeDocumentView`'s work-history entries
/// draw their heads with them when asked for the general-sheet style — which is
/// how the fresher's #1492 refusal and the employment's #1354 refusal survive a
/// change of layout instead of being re-implemented beside it.
library;

import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';

/// Which layout a shared work-history entry draws itself in.
enum ResumeEmploymentStyle {
  /// The trade sheet's v3 card: heading, then the span underneath it.
  card,

  /// The general sheet: title on the LEFT, dates on the RIGHT, work as a
  /// bullet (`.job-head { display: flex; justify-content: space-between }`).
  generalSheet,
}

/// One work-history head: the title takes the width the dates leave and wraps
/// inside it, so a long employer never runs under the dates.
///
/// [when] never wraps for an employer span (a date range is one token to the
/// eye); a fresher's duration is his OWN words, so [wrapWhen] lets it wrap
/// right-aligned within half the row — the sheet's `.when.dur` rule.
class ResumeSheetHeadRow extends StatelessWidget {
  const ResumeSheetHeadRow({
    super.key,
    required this.title,
    required this.when,
    this.titleSuffix,
    this.wrapWhen = false,
  });

  final String title;

  /// The muted tail of the title line — "· Gurugram, Haryana" on an employer
  /// block. PRE-COMPOSED with its own separator server-side, so it is appended
  /// verbatim and never re-split.
  final String? titleSuffix;

  final String when;
  final bool wrapWhen;

  @override
  Widget build(BuildContext context) {
    final String suffix = titleSuffix ?? '';
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Expanded(
          child: Text.rich(
            TextSpan(
              children: <InlineSpan>[
                TextSpan(
                  text: title,
                  style: OnboardingTypography.inter(
                    size: 14,
                    weight: FontWeight.w700,
                    height: 1.35,
                    color: OnboardingColors.ink900,
                  ),
                ),
                if (suffix.isNotEmpty)
                  TextSpan(
                    text: suffix,
                    style: OnboardingTypography.inter(
                      size: 12,
                      height: 1.35,
                      color: OnboardingColors.ink500,
                    ),
                  ),
              ],
            ),
          ),
        ),
        if (when.isNotEmpty) ...<Widget>[
          const SizedBox(width: 8),
          // A hard cap rather than Expanded: the dates column must not grow
          // past half the row at a 2.0 text scale, which is what would push the
          // title to one character per line.
          ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width / 2,
            ),
            child: Text(
              when,
              textAlign: TextAlign.right,
              softWrap: wrapWhen,
              overflow: wrapWhen ? TextOverflow.clip : TextOverflow.ellipsis,
              style: OnboardingTypography.inter(
                size: 12,
                height: 1.35,
                color: OnboardingColors.ink500,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// One bullet line — the sheet's `.bullet`, used for the work sentence and for
/// certificates and training rows.
class ResumeSheetBullet extends StatelessWidget {
  const ResumeSheetBullet({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final TextStyle style = OnboardingTypography.inter(
      size: 13,
      height: 1.45,
      color: OnboardingColors.ink600,
    );
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text('•  ', style: style),
        Expanded(child: Text(text, style: style)),
      ],
    );
  }
}

/// One promotion stint under its employer, with its dates BESIDE it rather than
/// at the right edge: that column is the one the eye runs down for employers,
/// and a stint's dates there would read as a second employer (the printed
/// sheet's own rule, for the same reason).
class ResumeSheetStint extends StatelessWidget {
  const ResumeSheetStint({
    super.key,
    required this.role,
    required this.when,
    required this.stepped,
  });

  final String role;
  final String when;

  /// Earlier stints step in; the current one sits flush.
  final bool stepped;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(top: 4, left: stepped ? 12 : 0),
      child: Text.rich(
        TextSpan(
          children: <InlineSpan>[
            TextSpan(
              text: role,
              style: OnboardingTypography.inter(
                size: 13,
                weight: FontWeight.w700,
                height: 1.35,
                color: OnboardingColors.ink900,
              ),
            ),
            if (when.isNotEmpty)
              TextSpan(
                text: '  $when',
                style: OnboardingTypography.inter(
                  size: 12,
                  height: 1.35,
                  color: OnboardingColors.ink500,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// One `Label: value` row — label bold with its colon, value regular, as the
/// general sheet prints it (`.lab { font-weight: 700 }` +
/// `.lab::after { content: ":" }`).
///
/// NOTE the weights are the OPPOSITE way round from the trade sheet's fact line
/// (muted label, semibold value). Deliberate: this is the general sheet's own
/// typography, from the owner's format.
class ResumeSheetLabelValue extends StatelessWidget {
  const ResumeSheetLabelValue({
    super.key,
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        children: <InlineSpan>[
          TextSpan(
            text: '$label: ',
            style: OnboardingTypography.inter(
              size: 13,
              weight: FontWeight.w700,
              height: 1.4,
              color: OnboardingColors.ink900,
            ),
          ),
          TextSpan(
            text: value,
            style: OnboardingTypography.inter(
              size: 13,
              height: 1.4,
              color: OnboardingColors.ink600,
            ),
          ),
        ],
      ),
    );
  }
}
