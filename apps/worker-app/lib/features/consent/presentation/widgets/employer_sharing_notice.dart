import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import 'consent_notice_parts.dart';

/// The DPDP employer-sharing notice (`employer_sharing` + `employer_messaging`),
/// in the kit's privacy card. ONE widget, shown on the onboarding consent
/// screen and on the existing-worker / Settings prompt.
///
/// ── THE WORDS ARE THE APPROVED NOTICE, VERBATIM. ─────────────────────────────
///
/// `docs/product/employer-sharing-consent-notice.md`, approved by the owner
/// 2026-11-04 — same words, same bold spans. Every line is a claim about the
/// code (see the doc's table). A wording change belongs in that doc first,
/// approved again, with `kConsentVersion` / `CURRENT_CONSENT_VERSION` bumped in
/// the same change.
///
/// Layout only is ours: the two lead-in lines are set in a medium weight (not
/// bold — the doc does not bold them) so the bold spans inside them still read
/// as emphasis.
class EmployerSharingNotice extends StatelessWidget {
  const EmployerSharingNotice({super.key});

  /// The approved heading.
  static const String heading = 'Companies aapki profile dekh sakti hain';

  @override
  Widget build(BuildContext context) {
    final TextStyle leadIn = OnboardingTypography.inter(
      size: 14,
      weight: FontWeight.w500,
      height: 1.4,
    );
    return ConsentNoticeCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            heading,
            style: OnboardingTypography.questionHeadline(
              color: OnboardingColors.shiftBlue,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Aapko kaam dilaane ke liye, BadaBhai aapki kaam ki profile '
            'companies aur placement agencies ko dikhata hai.',
            style: OnboardingTypography.bodyMuted(),
          ),
          const _NoticeDivider(),
          Text('Woh sirf yeh dekhte hain:', style: leadIn),
          const SizedBox(height: 14),
          const ConsentBullet(<NoticeRun>[
            ('Aapka kaam (jaise CNC Turner) aur anubhav', false),
          ]),
          const ConsentBullet(<NoticeRun>[
            ('Aapki industry, shehar aur level', false),
          ]),
          Text.rich(
            TextSpan(
              style: OnboardingTypography.inter(size: 13, height: 1.45),
              children: noticeSpans(const <NoticeRun>[
                ('Aapka ', false),
                ('naam, phone number aur photo', true),
                (' nahi dikhta.', false),
              ]),
            ),
          ),
          const _NoticeDivider(),
          Text.rich(
            TextSpan(
              style: leadIn,
              children: noticeSpans(const <NoticeRun>[
                ('Agar koi company paise dekar aapki profile ', false),
                ('unlock', true),
                (' karti hai, to 14 din tak:', false),
              ]),
            ),
          ),
          const SizedBox(height: 14),
          const ConsentBullet(<NoticeRun>[
            ('Woh aapka ', false),
            ('resume', true),
            (' dekh sakti hai — usme aapka ', false),
            ('phone number', true),
            (' hota hai (poora naam, photo aur salary ki ummeed nahi).', false),
          ]),
          const ConsentBullet(<NoticeRun>[
            ('Woh aapko ', false),
            ('BadaBhai ke andar message', true),
            (' kar sakti hai.', false),
          ]),
          const SizedBox(height: 8),
          const ConsentNoteBox(<NoticeRun>[
            ('Aap jab chaahein ', false),
            ('Settings', true),
            (
              ' me jaakar yeh band kar sakte hain. Phir companies aapko '
                  'dhoondh ya message nahi kar paayengi. Jo resume pehle dekha '
                  'ja chuka hai, woh wapas nahi hota.',
              false,
            ),
          ]),
        ],
      ),
    );
  }
}

class _NoticeDivider extends StatelessWidget {
  const _NoticeDivider();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Divider(color: OnboardingColors.borderSubtle, height: 1),
      );
}
