import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../router.dart';
import 'cubit/consent_cubit.dart';

/// Handed to `/consent` as go_router `extra` when the screen is PUSHED over a
/// surface the worker must be able to get back to, rather than entered as the
/// FIRST step of onboarding.
///
/// Today that is the feedback screen recovering from a `ConsentGuard` 403: the
/// worker has a paragraph in a box and only came here to unblock sending it.
/// Carrying them on into `/name` → the profiling interview would be hijacking an
/// already-onboarded worker into a flow they finished long ago.
///
/// A marker TYPE rather than a bool or a magic string, so a stray `extra` from
/// some other caller can never accidentally mean "this is a recovery".
class ConsentReturnIntent {
  const ConsentReturnIntent();
}

class ConsentScreen extends StatelessWidget {
  const ConsentScreen({super.key, this.returnToCaller = false});

  /// Build from a go_router `extra`. The ONE rule that decides
  /// onboarding-vs-recovery lives here rather than in the route table, so it is
  /// exercised by the tests that drive this screen instead of being a line in
  /// `router.dart` that nothing reads.
  factory ConsentScreen.fromExtra(Object? extra) =>
      ConsentScreen(returnToCaller: extra is ConsentReturnIntent);

  /// True when this screen was pushed with [ConsentReturnIntent] — offer a way
  /// back, and pop with the outcome instead of continuing into onboarding.
  final bool returnToCaller;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ConsentCubit>(
      create: (_) => locator<ConsentCubit>(),
      child: _ConsentView(returnToCaller: returnToCaller),
    );
  }
}

class _ConsentView extends StatelessWidget {
  const _ConsentView({required this.returnToCaller});

  final bool returnToCaller;

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ConsentCubit, ConsentState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, ConsentState state) {
        if (state.status == ConsentStatus.success) {
          if (returnToCaller && context.canPop()) {
            // A RECOVERY, not onboarding (see [ConsentReturnIntent]). Hand the
            // outcome back and return the worker to the screen they were working
            // on.
            context.pop(true);
            return;
          }
          // #381 — go, NOT push. Pushing left the ACCEPTED consent screen alive
          // underneath, so system back walked the worker straight back onto a
          // consent they had already given — and re-accepting fires a second
          // `consent.accepted` onto the event-first audit spine (§1). Consent is
          // a gate you pass through once, not a page you browse.
          context.go(Routes.name);
        }
      },
      builder: (BuildContext context, ConsentState state) {
        final ConsentCubit cubit = context.read<ConsentCubit>();
        // BACK BUTTON: none on the onboarding path — consent is a gate you pass
        // through once (#381). It appears ONLY on the pushed recovery path
        // ([ConsentReturnIntent]), where the worker must be able to decline and
        // go back to what they were doing.
        final bool canGoBack = returnToCaller && context.canPop();
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              _PrivacyTopBar(
                onBack: canGoBack ? () => context.pop(false) : null,
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  bottom: false,
                  child: OnboardingBody(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        const _ShieldCard(),
                        const SizedBox(height: 12),
                        _NoticeCard(
                          accepted: state.accepted,
                          onAcceptedChanged: cubit.setAccepted,
                        ),
                        // Honest failure text — say what happened, in red,
                        // instead of a silently un-pressed button.
                        if (state.status == ConsentStatus.failure &&
                            state.message != null) ...<Widget>[
                          const SizedBox(height: 12),
                          Row(
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
                                  state.message!,
                                  style: OnboardingTypography.inter(
                                    size: 13,
                                    color: OnboardingColors.errorRed,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Center(
                    heightFactor: 1,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        maxWidth: OnboardingLayout.maxContentWidth,
                      ),
                      child: PrimaryActionButton(
                        label: 'Aage Badhein',
                        isLoading: state.isSubmitting,
                        // Still gated on the explicit tick — see [_NoticeCard].
                        onPressed: state.canSubmit ? cubit.submit : null,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The kit's privacy top bar: a navy strip with a back arrow, `YOUR PRIVACY`
/// centred in safety yellow, and an India flag chip.
///
/// Both side slots are a fixed 48px so the title is TRULY centred whether or
/// not the back arrow is drawn (it is absent on the onboarding path).
class _PrivacyTopBar extends StatelessWidget {
  const _PrivacyTopBar({this.onBack});

  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        color: OnboardingColors.shiftBlue,
        padding: EdgeInsets.only(
          top: MediaQuery.paddingOf(context).top + 10,
          bottom: 16,
          left: 16,
          right: 16,
        ),
        child: Center(
          heightFactor: 1,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: OnboardingLayout.maxContentWidth,
            ),
            child: Row(
              children: <Widget>[
                SizedBox(
                  width: OnboardingLayout.tapTarget,
                  child: onBack == null
                      ? null
                      : IconButton(
                          tooltip: 'Wapas',
                          onPressed: onBack,
                          icon: const Icon(
                            Icons.arrow_back_ios_new_rounded,
                            color: OnboardingColors.textOnBlue,
                            size: 20,
                          ),
                        ),
                ),
                Expanded(
                  child: Text(
                    'YOUR PRIVACY',
                    textAlign: TextAlign.center,
                    style: OnboardingTypography.anek(
                      size: 18,
                      weight: FontWeight.w800,
                      color: OnboardingColors.safetyYellow,
                      letterSpacing: 1,
                    ),
                  ),
                ),
                SizedBox(
                  width: OnboardingLayout.tapTarget,
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 4,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.15),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: const Text(
                        '🇮🇳',
                        style: TextStyle(fontSize: 14),
                      ),
                    ),
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

/// The kit's shield card: a white card holding a soft-blue disc with the navy
/// shield outline.
class _ShieldCard extends StatelessWidget {
  const _ShieldCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 20),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      alignment: Alignment.center,
      child: Container(
        width: 54,
        height: 54,
        decoration: const BoxDecoration(
          color: OnboardingColors.shieldCircle,
          shape: BoxShape.circle,
        ),
        child: const Icon(
          Icons.shield_outlined,
          color: OnboardingColors.shiftBlue,
          size: 28,
        ),
      ),
    );
  }
}

/// The DPDP voice-consent notice, in the kit's card.
///
/// ── THE LAYOUT IS THE KIT'S. THE WORDS ARE NOT, AND MUST NOT BE. ─────────────
///
/// This copy is the APPROVED notice from
/// `docs/product/voice-consent-notice.DRAFT.md`, signed off in #1269
/// (2026-08-28), rendered VERBATIM — including the bold spans that document
/// marks, which this screen now carries for the first time. Do not paraphrase
/// or re-translate it here: a wording change belongs in that doc, reviewed
/// again, with `CURRENT_CONSENT_VERSION` bumped alongside it.
///
/// The UI kit proposed different bullets. They were NOT applied, because they
/// would have made the notice untrue: they drop the name of the third-party
/// processor (Sarvam — DPDP requires identifying the processor), drop that the
/// recording is kept indefinitely, and add "bina ijaazat kisi anjaan teesre
/// paksh ko nahi diya jaata", which the Sarvam transfer contradicts.
///
/// The ONE addition is the kit's "Dhyaan dein:" lead-in on the closing line —
/// a label, not a claim. The erasure sentence stays unrendered until #1271.
///
/// The explicit "I agree" tick also stays. The kit's screen has only a Continue
/// button, but DPDP consent needs a clear affirmative act, and that tick is it.
class _NoticeCard extends StatelessWidget {
  const _NoticeCard({required this.accepted, required this.onAcceptedChanged});

  final bool accepted;
  final ValueChanged<bool> onAcceptedChanged;

  static TextStyle get _bold =>
      const TextStyle(fontWeight: FontWeight.w700);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Aapki awaaz record karne ki ijaazat',
            style: OnboardingTypography.questionHeadline(
              color: OnboardingColors.shiftBlue,
            ),
          ),
          const SizedBox(height: 6),
          Text.rich(
            TextSpan(
              style: OnboardingTypography.bodyMuted(),
              children: <InlineSpan>[
                const TextSpan(text: 'Aap chaahein to sawaalon ka jawaab '),
                TextSpan(text: 'bolkar', style: _bold),
                const TextSpan(text: ' de sakte hain.'),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 14),
            child: Divider(color: OnboardingColors.borderSubtle, height: 1),
          ),
          Text(
            'Agar aap bolkar jawaab dete hain:',
            style: OnboardingTypography.inter(
              size: 14,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 14),
          const _ConsentBullet(<(String, bool)>[
            ('Aapki ', false),
            ('awaaz record hoti hai', true),
            (' aur humaare paas save rehti hai.', false),
          ]),
          const _ConsentBullet(<(String, bool)>[
            ('Us recording ko likhne ke liye hum use ', false),
            ('Sarvam', true),
            (' naam ki ek doosri company ko bhejte hain.', false),
          ]),
          const _ConsentBullet(<(String, bool)>[
            ('Recording ', false),
            ('hamesha ke liye save rehti hai', true),
            (' — hum use apne aap nahi hataate.', false),
          ]),
          const _ConsentBullet(<(String, bool)>[
            ('Aapki awaaz ka istemaal kisi AI ko sikhaane ke liye ', false),
            ('nahi', true),
            (' kiya jaata.', false),
          ]),
          const SizedBox(height: 8),
          Container(
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
                  const TextSpan(
                    text: 'Dhyaan dein: ',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: OnboardingColors.ink900,
                    ),
                  ),
                  const TextSpan(
                    text: 'Agar aap ijaazat nahi dete, tab bhi aap ',
                  ),
                  TextSpan(text: 'poora interview type karke', style: _bold),
                  const TextSpan(
                    text: ' de sakte hain. Kuch bhi kam nahi hota — sirf mic '
                        'band rehta hai.',
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Divider(color: OnboardingColors.borderSubtle, height: 1),
          const SizedBox(height: 8),
          InkWell(
            onTap: () => onAcceptedChanged(!accepted),
            borderRadius: BorderRadius.circular(OnboardingRadii.note),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: <Widget>[
                  Checkbox(
                    value: accepted,
                    activeColor: OnboardingColors.shiftBlue,
                    side: const BorderSide(
                      color: OnboardingColors.borderDefault,
                      width: 1.5,
                    ),
                    onChanged: (bool? v) => onAcceptedChanged(v ?? false),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'I agree',
                      style: OnboardingTypography.inter(
                        size: 14,
                        weight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// One line of the notice's bulleted list: the kit's 7px navy dot, then the
/// approved text with its bold spans. The text wraps under its own column, not
/// under the dot.
class _ConsentBullet extends StatelessWidget {
  const _ConsentBullet(this.parts);

  /// (text, isBold) runs, in order.
  final List<(String, bool)> parts;

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
                children: <InlineSpan>[
                  for (final (String text, bool bold) in parts)
                    TextSpan(
                      text: text,
                      style: bold
                          ? const TextStyle(fontWeight: FontWeight.w700)
                          : null,
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
