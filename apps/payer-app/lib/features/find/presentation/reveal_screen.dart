import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_haptics.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/name_mask.dart';
import '../../../core/widgets/bb_animated_switcher.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_copy_button.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_stamp_celebration.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/reveal_cubit.dart';
import 'reveal_args.dart';

/// Hands a signed, expiring URL to the OS. Returns false when nothing on the
/// device could open it.
typedef SignedUrlLauncher = Future<bool> Function(Uri url);

/// The production launcher: hand the url to a SEPARATE app (the browser) rather
/// than an in-app webview, so the token never lands in this app's webview cache
/// or history. Public only so a test that overrides the seam can restore it.
Future<bool> defaultSignedUrlLauncher(Uri url) =>
    launchUrl(url, mode: LaunchMode.externalApplication);

/// #354 — the seam the signed masked-résumé URL leaves through, and the ONLY one
/// it may leave through.
///
/// That URL is a bearer capability: until its signature expires, anyone holding
/// it can fetch the worker's résumé with no BadaBhai auth. So it is launched
/// straight into the OS browser and is NEVER copied to the clipboard, logged,
/// persisted, or rendered on screen (CLAUDE.md §2). It previously rode the
/// shared OS clipboard, which any focused app/IME can read, which
/// Gboard/Samsung/Windows Phone Link sync off-device, and which Android keeps in
/// clipboard history — so the capability outlived the screen.
///
/// Overridable so widget tests can assert WHERE the URL went without a platform
/// channel (`launchUrl` throws MissingPluginException under `flutter test`).
/// Production must always leave this as [defaultSignedUrlLauncher].
@visibleForTesting
SignedUrlLauncher revealSignedUrlLauncher = defaultSignedUrlLauncher;

/// The relay card's copy action (#2596) — it copies the handle and confirms in
/// place (icon → check), with no toast.
const String kCopyRelayHandleLabel = 'Copy relay handle';

/// What a screen reader hears as the unlock stamp lands (#2596) — the spoken
/// half of the "Unlocked!" toast the stamp replaced.
const String kUnlockedAnnouncement = 'Candidate unlocked';

/// Title of the toast that confirms a fresh unlock when its relay did not
/// resolve, so no stamp can land (#2596 / #1077).
const String kUnlockedToastTitle = 'Unlocked!';

/// The relay card's closed state: the neutral deny and an outage alike.
const String kRelayUnavailableMessage =
    'Contact relay is not available right now.';

/// Revealed profile. Two shapes behind one screen (see [RevealArgs]):
///
///  - MOCK — the kit's rich reveal: real name + phone (mono pill), skills, and a
///    resume download row. Only reachable after a paid mock unlock.
///  - REAL — the faceless per-job applicant OR all-candidates row + the in-app
///    RELAY handle from `POST /payer/unlocks/:id/reveal` and a MASKED résumé
///    disclosure. The backend returns NO name/phone, so none is ever
///    fabricated here.
///
/// The one-shot success stamp (+ a medium haptic + a spoken "unlocked") plays
/// ONLY when the reveal was opened by the unlock that just happened
/// ([RevealArgs.justUnlocked]), never on a "View" of an earlier unlock (#2596)
/// — and, on the real reveal, only once the relay resolved (#1077): no seal
/// lands over a "relay not available" card. That unlock still gets its one
/// confirmation: a "Unlocked!" toast with the same medium haptic.
class RevealScreen extends StatelessWidget {
  const RevealScreen({
    super.key,
    required this.args,
    required this.onBack,
  });

  final RevealArgs args;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    if (args.isReal) {
      return BlocProvider<RevealCubit>(
        create: (_) => locator<RevealCubit>()..load(args.unlockId!),
        child: _RealReveal(args: args, onBack: onBack),
      );
    }
    return _MockReveal(
      candidate: args.candidate!,
      justUnlocked: args.justUnlocked,
      onBack: onBack,
    );
  }
}

// ===========================================================================
// REAL — relay handle + masked résumé (no fabricated name/phone)
// ===========================================================================

class _RealReveal extends StatelessWidget {
  const _RealReveal({required this.args, required this.onBack});

  final RevealArgs args;
  final VoidCallback onBack;

  Future<void> _downloadResume(BuildContext context) async {
    final RevealCubit cubit = context.read<RevealCubit>();
    // A search-row reveal carries no job: the masked résumé goes out with no
    // posting id (`job_posting_id` omitted — the route accepts that).
    final DisclosureResult result = await cubit.discloseResume(
      workerId: args.workerId,
      jobPostingId: args.jobId,
    );
    if (!context.mounted) return;
    // A 429 is the per-payer disclosure cap (XB-G, a harvest-velocity limiter)
    // — NON-retry copy on purpose (review F3): "try again" would invite
    // hammering the limiter. No retry affordance, no refresh icon.
    if (cubit.state.disclosure == DisclosureStatus.limited) {
      showBbToast(
        context,
        title: 'Limit reached for now',
        message: 'Résumé limit reached for now — try again later.',
        icon: Icons.hourglass_bottom_rounded,
      );
      return;
    }
    // An OUTAGE (non-2xx/transport) is retryable — distinct from the neutral
    // deny below, whose copy is reserved for the genuine 200 {unavailable}.
    if (cubit.state.disclosure == DisclosureStatus.error) {
      showBbToast(
        context,
        title: 'Something went wrong',
        message: 'Could not fetch the résumé — try again.',
        icon: Icons.refresh_rounded,
      );
      return;
    }
    if (!result.disclosed) {
      showBbToast(
        context,
        title: 'Résumé unavailable',
        message: 'This masked résumé is not available right now.',
        icon: Icons.info_rounded,
      );
      return;
    }
    // #354 — LAUNCH the signed url, never copy it. See [revealSignedUrlLauncher]
    // for why the clipboard is the wrong surface for a bearer capability. The
    // handoff to the browser is one-shot: no copy is left behind on the device.
    bool opened;
    try {
      opened = await revealSignedUrlLauncher(Uri.parse(result.resumeUrl!));
    } catch (_) {
      // The error object is swallowed on purpose: a FormatException from
      // Uri.parse and a PlatformException from the launcher BOTH embed the
      // offending url in their message, so logging/rethrowing it would put the
      // signed capability into a crash report — exactly what #354 forbids.
      opened = false;
    }
    if (!context.mounted) return;
    if (!opened) {
      // Honest cause, not "check your internet": nothing on the device claimed
      // the https VIEW intent. No copy-to-clipboard fallback is offered — that
      // is the leak this issue removed, so a missing browser must stay a dead
      // end rather than silently reopening it.
      showBbToast(
        context,
        title: 'No app to open the résumé',
        message: 'Install a browser, then tap Masked résumé again.',
        icon: Icons.info_rounded,
      );
      return;
    }
    showBbToast(
      context,
      title: 'Masked résumé opened',
      message: 'Opened in your browser · PII redacted.',
    );
  }

  /// True on the one transition where the relay for the unlock that JUST
  /// happened comes back unavailable or failed. That is the case where the
  /// stamp stays off (#1077), so the grant needs its confirmation another way.
  /// Never for a "View" of an earlier unlock.
  bool _grantNotStamped(RevealState previous, RevealState current) =>
      args.justUnlocked &&
      previous.status != current.status &&
      (current.status == RevealStatus.unavailable ||
          current.status == RevealStatus.error);

  /// #2596 — confirms a fresh unlock exactly once when no stamp can land. The
  /// toast is a SnackBar, so TalkBack / VoiceOver announce it, and it carries
  /// the same single medium haptic the stamp would have fired.
  void _confirmGrant(BuildContext context, RevealState state) {
    AppHaptics.confirm();
    showBbToast(
      context,
      title: kUnlockedToastTitle,
      message: kRelayUnavailableMessage,
    );
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<RevealCubit, RevealState>(
      listenWhen: _grantNotStamped,
      listener: _confirmGrant,
      builder: (BuildContext context, RevealState state) {
        return Stack(
          children: <Widget>[
            ListView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                AppSpacing.s2,
                AppSpacing.gutter,
                AppSpacing.s6,
              ),
              children: <Widget>[
                _header(),
                const SizedBox(height: AppSpacing.s4),
                _identityCard(),
                const SizedBox(height: AppSpacing.s4),
                _relayCard(context, state),
                const SizedBox(height: AppSpacing.s4),
                _resumeRow(context, state),
              ],
            ),
            // #1077 / #2596 — the "stamp" beat for the paid conversion moment:
            // a green seal lands once, with a medium haptic, when the reveal of
            // the unlock that JUST happened resolves to a relay handle — never
            // for a "View" of an earlier one, and never over the "not
            // available" card (the header's Unlocked badge still says it).
            // Ignores pointer + auto-fades so it never blocks the relay/résumé
            // actions beneath it. A relay that does not resolve gets the
            // toast instead (see [_confirmGrant]).
            if (args.justUnlocked && state.status == RevealStatus.ready)
              const Positioned.fill(
                child: BbStampCelebration(
                  icon: Icons.lock_open_rounded,
                  haptic: true,
                  announcement: kUnlockedAnnouncement,
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _header() {
    return Row(
      children: <Widget>[
        BbIconButton(
          icon: Icons.arrow_back_rounded,
          semanticLabel: 'Back',
          onPressed: onBack,
        ),
        const SizedBox(width: AppSpacing.s3),
        Text(
          'Candidate',
          style: AppTypography.header(
            size: AppTypography.sizeLg,
            weight: FontWeight.w800,
          ),
        ),
        const Spacer(),
        const BbBadge('Unlocked', tone: BbBadgeTone.success, icon: Icons.lock_open_rounded),
      ],
    );
  }

  /// The masked identity block. Both real feeds fill it through [RevealArgs]:
  /// a masked handle + coarse facets, never a name or phone.
  Widget _identityCard() {
    final List<String> facets = args.facets;
    return BbCard(
      festive: true,
      padding: const EdgeInsets.all(AppSpacing.s6),
      child: Column(
        children: <Widget>[
          const BbAvatar(
            initials: '••',
            size: 84,
            mode: BbAvatarMode.masked,
            sealed: true,
          ),
          const SizedBox(height: AppSpacing.s3),
          Text(
            args.title,
            textAlign: TextAlign.center,
            style: AppTypography.mono(
              size: AppTypography.sizeXl,
              weight: FontWeight.w800,
            ),
          ),
          if (facets.isNotEmpty) ...<Widget>[
            const SizedBox(height: 2),
            Text(
              facets.join(' · '),
              textAlign: TextAlign.center,
              style: AppTypography.body(
                size: AppTypography.sizeBase,
                weight: FontWeight.w600,
                color: AppColors.textSecondary,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Identity stays masked — reach this candidate through the '
            'in-app relay below.',
            textAlign: TextAlign.center,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ),
    );
  }

  Widget _relayCard(BuildContext context, RevealState state) {
    final Widget card;
    final String phase;
    if (state.status == RevealStatus.loading ||
        state.status == RevealStatus.initial) {
      phase = 'loading';
      card = const BbCard(
        padding: EdgeInsets.all(AppSpacing.s6),
        child: Center(child: BbStatusView.loading()),
      );
    } else if (state.status == RevealStatus.unavailable ||
        state.status == RevealStatus.error) {
      phase = 'closed';
      card = BbCard(
        child: Row(
          children: <Widget>[
            const Icon(Icons.info_rounded, color: AppColors.textMuted),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: Text(
                kRelayUnavailableMessage,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
          ],
        ),
      );
    } else {
      phase = 'ready';
      final String handle = state.relayHandle ?? '';
      card = BbCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _sectionLabel('Contact relay'),
            const SizedBox(height: AppSpacing.s2),
            Row(
              children: <Widget>[
                BbBadge(state.channelLabel, tone: BbBadgeTone.neutral),
                const SizedBox(width: AppSpacing.s2),
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.s3,
                      vertical: AppSpacing.s2,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceSunken,
                      borderRadius: BorderRadius.circular(AppRadii.pill),
                    ),
                    child: Text(
                      handle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.mono(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            // #2596 — copies the opaque in-app handle and confirms in place:
            // the icon morphs to a check for a moment, then turns back.
            BbCopyButton(
              text: handle,
              label: kCopyRelayHandleLabel,
              block: true,
            ),
          ],
        ),
      );
    }
    // #1078 — ease the loading→ready/closed relay status swap instead of a hard
    // cut on the network round trip. KeyedSubtree gives each phase a distinct
    // key so the switcher actually animates between them.
    return BbAnimatedSwitcher(
      child: KeyedSubtree(key: ValueKey<String>(phase), child: card),
    );
  }

  Widget _resumeRow(BuildContext context, RevealState state) {
    final bool loading = state.disclosure == DisclosureStatus.loading;
    // While rate-limited (XB-G 429) the row is NOT tappable — the card itself
    // must not stay a retry affordance against the harvest-velocity limiter.
    final bool limited = state.disclosure == DisclosureStatus.limited;
    return BbCard(
      onTap: (loading || limited) ? null : () => _downloadResume(context),
      child: Row(
        children: <Widget>[
          Container(
            width: 46,
            height: 46,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AppColors.brandTint,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            child: const Icon(Icons.description_rounded,
                size: 24, color: AppColors.brandPress),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'Masked résumé',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w700,
                  ),
                ),
                Text(
                  switch (state.disclosure) {
                    // #354 — no longer "link copied": the url is opened, never
                    // put on the clipboard. Re-tapping mints a FRESH signed url
                    // (the previous one expires), so "open again" is accurate.
                    DisclosureStatus.ready =>
                      'Opened in your browser · tap to open again',
                    DisclosureStatus.limited =>
                      'Limit reached for now — try again later',
                    _ => 'PII redacted · generated by BadaBhai',
                  },
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          ),
          if (loading)
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            const Icon(Icons.download_rounded, size: 22, color: AppColors.textMuted),
        ],
      ),
    );
  }

  Widget _sectionLabel(String text) => Text(
        text.toUpperCase(),
        style: AppTypography.eyebrow(color: AppColors.textBrand),
      );
}

// ===========================================================================
// MOCK — the kit's rich reveal (unchanged design)
// ===========================================================================

class _MockReveal extends StatelessWidget {
  const _MockReveal({
    required this.candidate,
    required this.justUnlocked,
    required this.onBack,
  });

  final Candidate candidate;
  final bool justUnlocked;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    // The same one-shot stamp as the real reveal, on the same terms (#2596).
    return Stack(
      children: <Widget>[
        _list(),
        if (justUnlocked)
          const Positioned.fill(
            child: BbStampCelebration(
              icon: Icons.lock_open_rounded,
              haptic: true,
              announcement: kUnlockedAnnouncement,
            ),
          ),
      ],
    );
  }

  Widget _list() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      children: <Widget>[
        Row(
          children: <Widget>[
            BbIconButton(
              icon: Icons.arrow_back_rounded,
              semanticLabel: 'Back',
              onPressed: onBack,
            ),
            const SizedBox(width: AppSpacing.s3),
            Text(
              'Candidate',
              style: AppTypography.header(
                size: AppTypography.sizeLg,
                weight: FontWeight.w800,
              ),
            ),
            const Spacer(),
            const BbBadge(
              'Unlocked',
              tone: BbBadgeTone.success,
              icon: Icons.lock_open_rounded,
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        BbCard(
          festive: true,
          padding: const EdgeInsets.all(AppSpacing.s6),
          child: Column(
            children: <Widget>[
              BbAvatar(
                initials: NameMask.initials(candidate.name),
                size: 84,
                sealed: true,
              ),
              const SizedBox(height: AppSpacing.s3),
              Text(
                candidate.name,
                textAlign: TextAlign.center,
                style: AppTypography.header(
                  size: AppTypography.sizeXl,
                  weight: FontWeight.w800,
                ),
              ),
              Text(
                '${candidate.trade} · ${candidate.exp}',
                style: AppTypography.body(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w600,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: AppSpacing.s3),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.s4,
                  vertical: AppSpacing.s2,
                ),
                decoration: BoxDecoration(
                  color: AppColors.surfaceSunken,
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(Icons.phone_rounded, size: 16, color: AppColors.success),
                    const SizedBox(width: 6),
                    Text(
                      candidate.phone,
                      style: AppTypography.mono(
                        size: AppTypography.sizeBase,
                        weight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _sectionLabel('Skills'),
              const SizedBox(height: AppSpacing.s2),
              Wrap(
                spacing: 7,
                runSpacing: 7,
                children: <Widget>[
                  BbBadge(candidate.skill, tone: BbBadgeTone.neutral),
                  const BbBadge('Quality check', tone: BbBadgeTone.neutral),
                  const BbBadge('Shift work', tone: BbBadgeTone.neutral),
                ],
              ),
              const SizedBox(height: AppSpacing.s4),
              _sectionLabel('Location & availability'),
              const SizedBox(height: AppSpacing.s2),
              RichText(
                text: TextSpan(
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textSecondary,
                  ),
                  children: <InlineSpan>[
                    TextSpan(text: '${candidate.loc} · '),
                    TextSpan(
                      text: candidate.avail,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w600,
                        color: AppColors.success,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbCard(
          onTap: () {},
          child: Row(
            children: <Widget>[
              Container(
                width: 46,
                height: 46,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.brandTint,
                  borderRadius: BorderRadius.circular(AppRadii.md),
                ),
                child: const Icon(Icons.description_rounded,
                    size: 24, color: AppColors.brandPress),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'AI branded resume',
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      'Generated by BadaBhai · PDF',
                      style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        color: AppColors.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.download_rounded, size: 22, color: AppColors.textMuted),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbButton(
          label: 'Contact on WhatsApp',
          iconLeft: Icons.chat_rounded,
          block: true,
          onPressed: () {},
        ),
      ],
    );
  }

  Widget _sectionLabel(String text) {
    return Text(
      text.toUpperCase(),
      style: AppTypography.eyebrow(color: AppColors.textBrand),
    );
  }
}
