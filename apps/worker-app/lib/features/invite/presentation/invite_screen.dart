import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scroll_safe_body.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../domain/invite_repository.dart';
import 'cubit/invite_cubit.dart';
import '../../../core/widgets/feedback_fab.dart';

/// The hero disc behind the invite glyph.
const double _kHeroDisc = 96;

/// "Dost ko invite karein" (A3). Creates a referral invite on open and shares the
/// link via the platform sheet. Warm bada-bhai voice; PII-free (only the code).
class InviteScreen extends StatelessWidget {
  const InviteScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<InviteCubit>(
      create: (_) => locator<InviteCubit>()..load(),
      child: const _InviteView(),
    );
  }
}

class _InviteView extends StatelessWidget {
  const _InviteView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          // Kit chrome (spec §2.1): a full-bleed navy band with the back arrow
          // on the gutter, the Anek title and the muted subtitle.
          ShiftBlueHeader(
            title: 'Dost ko invite karein',
            subtitle: 'Referral link share karein',
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: BlocBuilder<InviteCubit, InviteState>(
                builder: (BuildContext context, InviteState state) {
                  return switch (state.status) {
                    InviteStatus.loading => const BbStatusView.loading(),
                    InviteStatus.error => BbStatusView(
                      icon: failureReason(state.failure).icon,
                      title: 'Invite link nahi bani.',
                      subtitle: failureReason(state.failure).reason,
                      action: FilledButton(
                        onPressed: () => context.read<InviteCubit>().load(),
                        child: const Text('Dobara try karein'),
                      ),
                    ),
                    InviteStatus.ready => _ready(context, state.link!),
                  };
                },
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _ready(BuildContext context, InviteLink link) {
    // Scroll-safe: the Spacer keeps the share CTAs pinned to the bottom on a tall
    // screen, and the body scrolls (never a RenderFlex overflow) on a short
    // handset or at a large accessibility text scale. HORIZONTAL padding rides
    // the scroll view — which is also what caps the column at 440 and centres it
    // on a tablet (D7) — and the vertical padding stays INSIDE the wrapper so it
    // does not add a spurious scroll on tall screens.
    return BbScrollSafeBody(
      padding: KitInsets.list(
        MediaQuery.sizeOf(context).width,
        max: OnboardingLayout.maxContentWidth,
        gutter: 16,
      ),
      child: Padding(
        // The bottom also reserves the band the floating Feedback pill
        // occupies: this screen's CTAs are IN THE BODY (no docked bar), so the
        // pill landed squarely on 'Link share karein'. See [FeedbackFabInset].
        padding: EdgeInsets.only(
          top: 16,
          bottom: 16 + FeedbackFabInset.of(context),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Center(
              child: Container(
                width: _kHeroDisc,
                height: _kHeroDisc,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  color: OnboardingColors.selectedCardBg,
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.group_add_rounded,
                  size: 48,
                  color: OnboardingColors.safetyYellowDark,
                ),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              'Apne dost ko BadaBhai par bulao',
              textAlign: TextAlign.center,
              style: OnboardingTypography.questionHeadline(),
            ),
            const SizedBox(height: 8),
            Text(
              'Woh bhi apna profile banakar factory jobs pa sakte hain — no test, '
              'bas baat-cheet.',
              textAlign: TextAlign.center,
              style: OnboardingTypography.bodyMuted(),
            ),
            const SizedBox(height: 20),
            _linkChip(context, link),
            const Spacer(),
            // The ONE yellow CTA (kit: a single primary per screen) — opens the
            // OS share sheet with the referral link.
            PrimaryActionButton(
              label: 'Link share karein',
              leadingIcon: Icons.share_rounded,
              showArrow: false,
              onPressed: () => context.read<InviteCubit>().shareInvite(),
            ),
            const SizedBox(height: 10),
            // WhatsApp is the worker's default share target — GREEN is the kit's
            // WhatsApp/success colour. This opens WhatsApp DIRECTLY (wa.me contact
            // picker, message pre-filled); it used to call the same generic sheet
            // as the button above, so the label was a promise the code did not
            // keep. Falls back to the sheet when WhatsApp cannot be opened.
            BbButton(
              label: 'WhatsApp pe bhejein',
              block: true,
              variant: BbButtonVariant.success,
              iconLeft: Icons.chat_rounded,
              onPressed: () =>
                  context.read<InviteCubit>().shareInviteOnWhatsApp(),
            ),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  Widget _linkChip(BuildContext context, InviteLink link) {
    return Container(
      padding: const EdgeInsets.only(left: 14, right: 4, top: 4, bottom: 4),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        border: Border.all(color: OnboardingColors.borderDefault, width: 1.2),
      ),
      child: Row(
        children: <Widget>[
          const Icon(
            Icons.link_rounded,
            size: 20,
            color: OnboardingColors.ink500,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              link.url,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              // A link is a code: mono, so a worker reading it out loud cannot
              // confuse an l for a 1.
              style: OnboardingTypography.mono(
                size: 13,
                weight: FontWeight.w500,
                color: OnboardingColors.ink900,
              ),
            ),
          ),
          // The link was DISPLAYED but not copyable — a worker who wanted to
          // paste it into an app the share sheet does not list had no way to
          // get it. Ellipsised text cannot be selected out either.
          IconButton(
            icon: const Icon(Icons.copy_rounded, size: 20),
            color: OnboardingColors.ink600,
            tooltip: 'Link copy karein',
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints.tightFor(
              width: OnboardingLayout.tapTarget,
              height: OnboardingLayout.tapTarget,
            ),
            onPressed: () => _copyLink(context),
          ),
        ],
      ),
    );
  }

  Future<void> _copyLink(BuildContext context) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final bool copied = await context.read<InviteCubit>().copyInviteLink();
    // The cubit reports whether the clipboard actually took the text; a refused
    // clipboard must not be confirmed as "Copied".
    messenger.showSnackBar(
      SnackBar(
        content: Text(copied ? 'Link copy ho gaya' : 'Link copy nahi ho paya'),
        duration: const Duration(seconds: 2),
      ),
    );
  }
}
