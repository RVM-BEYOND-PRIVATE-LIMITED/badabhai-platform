import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';

/// One run of approved notice copy: its text, and whether the approved doc
/// marks it **bold**.
typedef NoticeRun = (String, bool);

/// The white card every DPDP notice sits in (the kit's privacy card).
class ConsentNoticeCard extends StatelessWidget {
  const ConsentNoticeCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      child: child,
    );
  }
}

/// One line of a notice's bulleted list: the kit's 7px navy dot, then the
/// approved text with its bold spans. The text wraps under its own column, not
/// under the dot.
class ConsentBullet extends StatelessWidget {
  const ConsentBullet(this.parts, {super.key});

  /// (text, isBold) runs, in order.
  final List<NoticeRun> parts;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            margin: const EdgeInsets.only(top: 6, right: 10),
            width: 7,
            height: 7,
            decoration: const BoxDecoration(
              color: OnboardingColors.shiftBlue,
              shape: BoxShape.circle,
            ),
          ),
          Expanded(
            child: Text.rich(
              TextSpan(
                style: OnboardingTypography.inter(size: 13, height: 1.45),
                children: noticeSpans(parts),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The notice's closing "Dhyaan dein:" box: a soft note panel whose [lead]
/// label is set darker and bold, followed by the approved [parts].
class ConsentNoteBox extends StatelessWidget {
  const ConsentNoteBox(this.parts, {super.key, this.lead = 'Dhyaan dein: '});

  final String lead;
  final List<NoticeRun> parts;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: OnboardingColors.noteBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: Text.rich(
        TextSpan(
          style: OnboardingTypography.inter(
            size: 12,
            height: 1.4,
            color: OnboardingColors.ink600,
          ),
          children: <InlineSpan>[
            TextSpan(
              text: lead,
              style: const TextStyle(
                fontWeight: FontWeight.w700,
                color: OnboardingColors.ink900,
              ),
            ),
            ...noticeSpans(parts),
          ],
        ),
      ),
    );
  }
}

/// Honest failure text under a privacy notice — say what happened, in red,
/// instead of a silently un-pressed button.
class ConsentErrorLine extends StatelessWidget {
  const ConsentErrorLine(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Icon(
          Icons.error_outline_rounded,
          size: 18,
          color: OnboardingColors.errorRed,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            style: OnboardingTypography.inter(
              size: 13,
              color: OnboardingColors.errorRed,
            ),
          ),
        ),
      ],
    );
  }
}

/// (text, isBold) runs → spans; bold is the notice's one emphasis weight.
List<InlineSpan> noticeSpans(List<NoticeRun> parts) => <InlineSpan>[
      for (final (String text, bool bold) in parts)
        TextSpan(
          text: text,
          style: bold ? const TextStyle(fontWeight: FontWeight.w700) : null,
        ),
    ];
