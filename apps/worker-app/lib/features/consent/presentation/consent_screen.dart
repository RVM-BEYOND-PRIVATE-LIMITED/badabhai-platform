import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/kit/kit_docked_bar.dart';
import '../../../core/widgets/kit/kit_select_chip.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../router.dart';
import 'cubit/consent_cubit.dart';
import 'widgets/consent_notice_parts.dart';
import 'widgets/employer_sharing_notice.dart';
import 'widgets/privacy_chrome.dart';

/// OWNER ASK (2026-10-22) — the privacy screen's "I don't agree" choice: go on
/// without voice consent, answering by typing only.
const String kConsentDeclineLabel = "I don't agree";
const Key kConsentDeclineButtonKey = Key('consent-decline');

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
          // ADR-0048 — THE CHAT ASKS FOR THE NAME NOW (#1864). `/name` used to
          // sit here; the intake asks first name, surname, state and city as
          // the chat's opening turns instead, and only for what the worker's
          // record is actually missing. The route itself stays registered — a
          // worker mid-onboarding on an older build can have `/name` saved as
          // their durable step (#1470), and it must still resolve for them.
          context.go(Routes.chatProfiling);
        }
      },
      builder: (BuildContext context, ConsentState state) {
        final ConsentCubit cubit = context.read<ConsentCubit>();
        // TERMINAL under-18 screen. No retry: the server wrote no consent and
        // answering again cannot change the declaration. Acknowledging clears
        // the local session and lands on phone login.
        if (state.status == ConsentStatus.ageBlocked) {
          return _AgeBlockedView(onAcknowledge: cubit.acknowledgeAgeBlock);
        }
        // BACK BUTTON: none on the onboarding path — consent is a gate you pass
        // through once (#381). It appears ONLY on the pushed recovery path
        // ([ConsentReturnIntent]), where the worker must be able to decline and
        // go back to what they were doing.
        final bool canGoBack = returnToCaller && context.canPop();
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              PrivacyTopBar(
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
                        const PrivacyShieldDisc(),
                        const SizedBox(height: 12),
                        // 2026-11-04 — the approved employer-sharing notice.
                        // The ONE tick below covers this card and the voice
                        // card alike.
                        const EmployerSharingNotice(),
                        const SizedBox(height: 12),
                        const _NoticeCard(),
                        const SizedBox(height: 12),
                        _AgreeRow(
                          accepted: state.accepted,
                          onAcceptedChanged: cubit.setAccepted,
                          declined: state.declined,
                          onDeclinedChanged: cubit.setDeclined,
                        ),
                        const SizedBox(height: 12),
                        _AgeGateCard(
                          answer: state.age18Plus,
                          onAnswer: (bool value) =>
                              _answerAge(context, cubit, value),
                        ),
                        // Honest failure text — say what happened, in red,
                        // instead of a silently un-pressed button.
                        if (state.status == ConsentStatus.failure &&
                            state.message != null) ...<Widget>[
                          const SizedBox(height: 12),
                          ConsentErrorLine(state.message!),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              // Spec §3.5 docks this CTA: the kit's white bar with its hairline
              // top border, which also carries the safe-area inset and
              // publishes its own height (so nothing floating can cover it).
              KitDockedBar(
                child: PrimaryActionButton(
                  label: 'Aage Badhein',
                  isLoading: state.isSubmitting,
                  // Gated on the explicit tick ([_AgreeRow]) AND a yes/no age answer.
                  onPressed: state.canSubmit ? cubit.submit : null,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Records the age answer. A "Nahi" tap is confirmed first, so a mis-tap can
/// never put the worker on the terminal under-18 path.
Future<void> _answerAge(
  BuildContext context,
  ConsentCubit cubit,
  bool value,
) async {
  if (value) {
    cubit.setAge18Plus(true);
    return;
  }
  if (cubit.state.age18Plus == false) return;
  final bool confirmed = await showBbConfirm(
    context,
    title: 'Pakka?',
    message: 'Pakka? 18 saal se kam hone par abhi profile nahi ban sakti.',
    confirmLabel: 'Haan',
    cancelLabel: 'Nahi',
    destructive: true,
  );
  if (confirmed) cubit.setAge18Plus(false);
}

/// The sign-up age gate: one yes/no question, two chips, no birth year or DOB.
///
/// Every NEW consent is asked (owner ruling 2026-11-04) — onboarding and the
/// pushed consent after a withdrawal — because the trade is only picked later
/// and DPDP's minors rule does not depend on it.
class _AgeGateCard extends StatelessWidget {
  const _AgeGateCard({required this.answer, required this.onAnswer});

  final bool? answer;
  final ValueChanged<bool> onAnswer;

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
            'Kya aapki umar 18 saal ya usse zyada hai?',
            style: OnboardingTypography.questionHeadline(
              color: OnboardingColors.shiftBlue,
            ),
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              KitSelectChip(
                label: 'Haan, 18+ hoon',
                selected: answer == true,
                onTap: () => onAnswer(true),
              ),
              KitSelectChip(
                label: 'Nahi',
                selected: answer == false,
                onTap: () => onAnswer(false),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The terminal under-18 screen. No retry — the declaration is final for this
/// sign-up. The single acknowledge clears the local session and returns to
/// phone login.
class _AgeBlockedView extends StatelessWidget {
  const _AgeBlockedView({required this.onAcknowledge});

  final VoidCallback onAcknowledge;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Icon(
                Icons.lock_clock_rounded,
                size: 64,
                color: OnboardingColors.shiftBlue,
              ),
              const SizedBox(height: 24),
              Text(
                '18 saal ke baad aana',
                textAlign: TextAlign.center,
                style: OnboardingTypography.anek(
                  size: 26,
                  weight: FontWeight.w800,
                  color: OnboardingColors.shiftBlue,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                'Abhi profile nahi ban sakti. 18 saal poore hone par dobara '
                'sign in karein.',
                textAlign: TextAlign.center,
                style: OnboardingTypography.inter(
                  size: 15,
                  height: 1.45,
                  color: OnboardingColors.ink600,
                ),
              ),
              const SizedBox(height: 32),
              PrimaryActionButton(label: 'Theek hai', onPressed: onAcknowledge),
            ],
          ),
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
/// The "I agree" tick that used to close this card is now [_AgreeRow], below
/// BOTH notices, because one tick grants both (2026-11-04).
class _NoticeCard extends StatelessWidget {
  const _NoticeCard();

  /// OWNER ASK (2026-10-22) — the "I don't agree" tick right under "I agree".
  /// Ticking one clears the other (the cubit owns that rule).
  final bool declined;
  final ValueChanged<bool> onDeclinedChanged;

  static TextStyle get _bold => const TextStyle(fontWeight: FontWeight.w700);

  @override
  Widget build(BuildContext context) {
    return ConsentNoticeCard(
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
          const ConsentBullet(<NoticeRun>[
            ('Aapki ', false),
            ('awaaz record hoti hai', true),
            (' aur humaare paas save rehti hai.', false),
          ]),
          const ConsentBullet(<NoticeRun>[
            ('Us recording ko likhne ke liye hum use ', false),
            ('Sarvam', true),
            (' naam ki ek doosri company ko bhejte hain.', false),
          ]),
          const ConsentBullet(<NoticeRun>[
            ('Recording ', false),
            ('hamesha ke liye save rehti hai', true),
            (' — hum use apne aap nahi hataate.', false),
          ]),
          const ConsentBullet(<NoticeRun>[
            ('Aapki awaaz ka istemaal kisi AI ko sikhaane ke liye ', false),
            ('nahi', true),
            (' kiya jaata.', false),
          ]),
          const SizedBox(height: 8),
          const ConsentNoteBox(<NoticeRun>[
            ('Agar aap ijaazat nahi dete, tab bhi aap ', false),
            ('poora interview type karke', true),
            (
              ' de sakte hain. Kuch bhi kam nahi hota — sirf mic '
                  'band rehta hai.',
              false,
            ),
          ]),
        ],
      ),
    );
  }
}

/// The screen's ONE affirmative act: the "I agree" tick, in its own card below
/// BOTH notices, because it grants both (owner ruling 2026-11-04).
///
/// The kit's screen has only a Continue button, but DPDP consent needs a clear
/// affirmative act, and this tick is it — 'Aage Badhein' stays disabled until
/// it is ticked.
class _AgreeRow extends StatelessWidget {
  const _AgreeRow({required this.accepted, required this.onAcceptedChanged});

  final bool accepted;
  final ValueChanged<bool> onAcceptedChanged;

  @override
  Widget build(BuildContext context) {
    return ConsentNoticeCard(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: InkWell(
        onTap: () => onAcceptedChanged(!accepted),
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: <Widget>[
              // No local fill / side overrides: the app-wide checkbox theme
              // is the v3 drawing (navy fill, yellow border, yellow tick),
              // and an override here is how this tick quietly ended up
              // wearing a grey border while every other one wore yellow.
              Checkbox(
                value: accepted,
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
    );
  }
}
