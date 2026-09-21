import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/config/build_info.dart';
import '../../../core/config/remote_config.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/date_label.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../../consent/presentation/cubit/consent_withdraw_cubit.dart';
import '../../consent/presentation/cubit/employer_contact_cubit.dart';
import '../../../core/widgets/feedback_fab.dart';
import '../domain/notification_prefs_repository.dart';
import 'cubit/account_delete_cubit.dart';

/// Minimum clearance under the last row. The REAL clearance now comes from
/// [FeedbackFabInset], which knows the pill's live height and this page's own
/// bottom bar; this stays as the floor for a host that mounts no pill.
///
/// The pill IS shown on this screen (it is hidden only on the three tab roots),
/// and what it must never cover is the build-id footer.
const double _kFeedbackPillClearance = 96;

/// Below this width the pending-deletion banner's action drops UNDER its text
/// instead of sitting beside it.
const double _kBannerStackBelowWidth = 340;

/// Settings (spec §5.10). Most rows are inert for the alpha (a tap shows a
/// "coming soon" snackbar). Account-delete is hidden for now; the DPDP
/// 2-step flow (A4 + ADR-0031 grace window) will return once the delete
/// experience is redesigned.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    // Screen-scoped cubits. AccountDeleteCubit seeds `scheduled` from the
    // SessionRepository when a deletion is already pending (e.g. after a login
    // during the grace), so the banner shows without any network call.
    // ConsentWithdrawCubit drives the DPDP "withdraw consent" row.
    return MultiBlocProvider(
      providers: <BlocProvider<dynamic>>[
        BlocProvider<AccountDeleteCubit>(
          create: (_) => locator<AccountDeleteCubit>(),
        ),
        BlocProvider<ConsentWithdrawCubit>(
          create: (_) => locator<ConsentWithdrawCubit>(),
        ),
        // E0 C-2 (#1630) — loads server truth for the switch on mount.
        BlocProvider<EmployerContactCubit>(
          create: (_) => locator<EmployerContactCubit>()..load(),
        ),
      ],
      child: const _SettingsView(),
    );
  }
}

class _SettingsView extends StatelessWidget {
  const _SettingsView();

  void _comingSoon(BuildContext context) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(const SnackBar(content: Text('Jald aa raha hai')));
  }

  /// Step 0 → 1: the 7-day-grace confirmation, then kick off the OTP flow.
  Future<void> _confirmDelete(BuildContext context) async {
    final bool proceed = await showBbConfirm(
      context,
      title: 'Account delete karein?',
      message:
          'OTP verify karne ke baad aapka account 7 din mein delete ho jaata '
          'hai. Is dauraan aap kabhi bhi cancel kar sakte hain.',
      confirmLabel: 'Delete karein',
      destructive: true,
    );
    if (!proceed || !context.mounted) return;
    await _startDeleteOtpFlow(context);
  }

  /// Sends the delete OTP, then opens the OTP-entry dialog. Surfaces the honest
  /// reason on a request failure instead of silently dead-ending. On a confirmed
  /// schedule the dialog closes into the SCHEDULED state and the pending banner
  /// takes over — NO logout, NO navigation (ADR-0031: the worker keeps their
  /// session during the grace so they can cancel).
  Future<void> _startDeleteOtpFlow(BuildContext context) async {
    final AccountDeleteCubit cubit = context.read<AccountDeleteCubit>();
    await cubit.requestDelete();
    if (!context.mounted) return;
    final AccountDeleteState s = cubit.state;
    if (s.status != AccountDeleteStatus.otpSent) {
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(content: Text(failureReason(s.failure).reason)),
        );
      return;
    }

    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      barrierColor: OnboardingColors.scrim,
      builder: (BuildContext dialogContext) =>
          BlocProvider<AccountDeleteCubit>.value(
            value: cubit,
            child: const DeleteOtpDialog(),
          ),
    );
  }

  /// A settings group card — white paper, one hairline border, no shadow; the
  /// rows supply their own dividers (kit grouped-list idiom).
  ///
  /// The rows are clipped to the card's own radius, so a row's ink splash and
  /// its bottom hairline stop at the rounded corner instead of painting into it.
  Widget _group(List<Widget> rows) {
    return KitCard(
      padding: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        child: Column(children: rows),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Still [BbScaffold], with its own chrome switched off: the navy header has
    // to bleed into the status bar (so `safeArea: false`) and the list owns its
    // gutter (so `padded: false`). What it is kept FOR is the `bottomBarInset`
    // contract — a page with no bottom bar publishes 0, which is what keeps the
    // floating Feedback pill from floating at the height of whatever sticky CTA
    // the screen underneath this one still has mounted.
    return BbScaffold(
      padded: false,
      safeArea: false,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: 'Settings',
            // A pushed utility screen: back and title on one row, no brand
            // badge, so the list starts as high as possible.
            compact: true,
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: ListView(
              // The scroll view's own padding (D7), so the column centres on a
              // tablet while the scrollbar stays at the screen edge. `safeArea`
              // is off, so the system inset is added here.
              padding:
                  KitInsets.list(
                    MediaQuery.sizeOf(context).width,
                    max: OnboardingLayout.maxContentWidth,
                    gutter: 16,
                  ).copyWith(
                    top: 16,
                    bottom:
                        math.max(
                          _kFeedbackPillClearance,
                          FeedbackFabInset.of(context),
                        ) +
                        MediaQuery.paddingOf(context).bottom,
                  ),
              children: <Widget>[
                // HIDDEN FOR NOW: the 'Bhasha' language row — hidden across the
                // app until real localization ships (the picker only ever set
                // `X-Locale`, with no translated strings behind it). Restore it
                // with the splash picker.
                _group(<Widget>[
                  // B7 kill switch. Defaults to VISIBLE (today's behaviour); lets ops
                  // pause the referral funnel without shipping a build. Hiding the
                  // entry point does NOT disable attribution — a code already captured
                  // from a deep link / install referrer is still drained after consent.
                  if (!BbRemoteConfig.instance.inviteEntryHidden)
                    BbListRow.setting(
                      icon: Icons.person_add_alt_1_outlined,
                      title: 'Dost ko invite karein',
                      subtitle: 'Referral link share karein',
                      onTap: () => context.pushOnce(Routes.invite),
                    ),
                  BbListRow.setting(
                    icon: Icons.chat,
                    title: 'WhatsApp alerts',
                    subtitle: 'Job alert · resume · reply',
                    onTap: () => _comingSoon(context),
                  ),
                  const _NotificationsToggleRow(),
                ]),
                const SizedBox(height: 16),
                _group(<Widget>[
                  // #464 — RESTORED. The worker's only in-app way to kick a lost or
                  // stolen handset off their account (the emit-after-close crash in
                  // DevicesCubit.load, FI-001, that got it removed is now guarded at
                  // its source — DevicesScreen / Routes.devices are reachable again).
                  BbListRow.setting(
                    icon: Icons.devices_other_outlined,
                    title: 'Aapke devices',
                    subtitle: 'Logged-in devices dekhein · hatayein',
                    onTap: () => context.pushOnce(Routes.devices),
                  ),
                  BbListRow.setting(
                    icon: Icons.verified_user_outlined,
                    title: 'Privacy & data',
                    subtitle: 'Consent · download · delete',
                    onTap: () => _comingSoon(context),
                  ),
                  const _WithdrawConsentRow(),
                  const _EmployerContactRow(),
                ]),
                // Account delete hidden for now; will return after the flow is
                // redesigned.
                Visibility(
                  visible: false,
                  maintainState: true,
                  child: BlocConsumer<AccountDeleteCubit, AccountDeleteState>(
                    // React only to the cancel round trip resolving (cancelling →
                    // idle/scheduled) — the OTP dialog owns its own error surface.
                    listenWhen:
                        (AccountDeleteState prev, AccountDeleteState curr) =>
                            prev.status == AccountDeleteStatus.cancelling &&
                            curr.status != AccountDeleteStatus.cancelling,
                    listener: (BuildContext context, AccountDeleteState state) {
                      final ScaffoldMessengerState messenger =
                          ScaffoldMessenger.of(context)..clearSnackBars();
                      if (state.status == AccountDeleteStatus.idle) {
                        messenger.showSnackBar(
                          const SnackBar(
                            content: Text('Account delete cancel ho gaya'),
                          ),
                        );
                      } else {
                        // Cancel failed — the honest reason; the banner stays.
                        messenger.showSnackBar(
                          SnackBar(
                            content: Text(failureReason(state.failure).reason),
                          ),
                        );
                      }
                    },
                    builder: (BuildContext context, AccountDeleteState state) {
                      final bool pending =
                          state.status == AccountDeleteStatus.scheduled ||
                          state.status == AccountDeleteStatus.cancelling;
                      if (!pending) {
                        final bool requestInProgress =
                            state.status == AccountDeleteStatus.sendingOtp ||
                            state.status == AccountDeleteStatus.otpSent ||
                            state.status == AccountDeleteStatus.confirming;
                        final Widget row = BbListRow.setting(
                          icon: Icons.delete_outline,
                          title: 'Account delete karein',
                          subtitle: 'OTP ke baad 7 din mein',
                          danger: true,
                          onTap: requestInProgress
                              ? null
                              : () => _confirmDelete(context),
                        );
                        if (requestInProgress) {
                          return IgnorePointer(
                            child: Opacity(opacity: 0.45, child: row),
                          );
                        }
                        return row;
                      }
                      return _PendingDeletionBanner(state: state);
                    },
                  ),
                ),
                const SizedBox(height: 20),
                // Version + BUILD id (#966). The build id is shown inline so a tester
                // can READ and quote exactly which build their device runs — the only
                // in-app way to tell a real bug from a stale APK — and a LONG-PRESS
                // copies it to the clipboard for a bug report. `kAppBuild` is a
                // PII-free commit SHA / build number ("dev" in a debug build).
                GestureDetector(
                  // The long-press target is the whole 48dp band, not the 14dp
                  // line of 11pt text: a press-and-hold on a strip that thin is
                  // not a control a gloved thumb can find (D6 — and the
                  // accessibility tap-target guideline counts long-press nodes
                  // exactly like taps).
                  behavior: HitTestBehavior.opaque,
                  onLongPress: () {
                    Clipboard.setData(const ClipboardData(text: kAppBuild));
                    ScaffoldMessenger.of(context)
                      ..clearSnackBars()
                      ..showSnackBar(
                        const SnackBar(content: Text('Build id copy ho gaya')),
                      );
                  },
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(
                      minHeight: OnboardingLayout.tapTarget,
                    ),
                    // heightFactor 1 so the band grows with a wrapped footer at
                    // a large system font instead of being pinned to 48.
                    child: Align(
                      heightFactor: 1,
                      child: Text(
                        // The build flavour is a DEVELOPER token, so it is
                        // printed only where a developer can see it. A worker
                        // reading 'build dev' on a shipped app learns nothing
                        // and doubts everything.
                        kReleaseMode
                            ? 'BadaBhai · v1.0 · Made in India'
                            : 'BadaBhai · v1.0 · build $kAppBuild · '
                                  'Made in India',
                        textAlign: TextAlign.center,
                        style: OnboardingTypography.inter(
                          size: 11,
                          color: OnboardingColors.ink500,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The grace-window banner that replaces the delete row while a deletion is
/// pending (ADR-0031): when the account will be deleted + the explicit
/// "Delete cancel karein" action. A soft yellow attention surface with ink text,
/// mirroring the non-danger treatment of the delete row — nothing is deleted yet,
/// so this is not a red alarm.
class _PendingDeletionBanner extends StatelessWidget {
  const _PendingDeletionBanner({required this.state});

  final AccountDeleteState state;

  @override
  Widget build(BuildContext context) {
    final bool cancelling = state.status == AccountDeleteStatus.cancelling;
    final DateTime? due = state.scheduledFor;
    final String line = due == null
        ? 'Account 7 din mein delete hoga'
        : 'Account ${absoluteDateLabel(due)} ko delete hoga';

    final Widget text = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          line,
          style: OnboardingTypography.inter(size: 14, weight: FontWeight.w600),
        ),
        const SizedBox(height: 2),
        Text(
          'Aap is dauraan cancel kar sakte hain',
          style: OnboardingTypography.inter(
            size: 12,
            color: OnboardingColors.ink600,
          ),
        ),
      ],
    );

    final Widget action = TextButton(
      style: TextButton.styleFrom(
        foregroundColor: OnboardingColors.shiftBlue,
        textStyle: OnboardingTypography.inter(
          size: 13,
          weight: FontWeight.w700,
          color: OnboardingColors.shiftBlue,
        ),
        minimumSize: const Size(
          OnboardingLayout.tapTarget,
          OnboardingLayout.tapTarget,
        ),
        tapTargetSize: MaterialTapTargetSize.padded,
      ),
      onPressed: cancelling
          ? null
          : () => context.read<AccountDeleteCubit>().cancelDelete(),
      child: cancelling
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: OnboardingColors.shiftBlue,
              ),
            )
          : const Text('Delete cancel karein'),
    );

    // On a narrow handset the date line and a 48dp action cannot share a row
    // without squeezing the date to two or three words per line.
    final bool stack =
        MediaQuery.sizeOf(context).width < _kBannerStackBelowWidth;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: OnboardingColors.selectedCardBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        border: Border.all(color: OnboardingColors.safetyYellow),
      ),
      child: stack
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    const Icon(
                      Icons.schedule_rounded,
                      color: OnboardingColors.safetyYellowDark,
                    ),
                    const SizedBox(width: 12),
                    Expanded(child: text),
                  ],
                ),
                Align(alignment: Alignment.centerLeft, child: action),
              ],
            )
          : Row(
              children: <Widget>[
                const Icon(
                  Icons.schedule_rounded,
                  color: OnboardingColors.safetyYellowDark,
                ),
                const SizedBox(width: 12),
                Expanded(child: text),
                const SizedBox(width: 8),
                action,
              ],
            ),
    );
  }
}

/// The OTP-entry step of account delete. Reacts to [AccountDeleteCubit]: shows a
/// countdown from the resend cooldown, offers a REAL resend once it elapses,
/// submits the OTP, surfaces the honest error (bad OTP / rate-limit), and pops
/// once the delete is SCHEDULED (the banner behind it takes over).
///
/// Public only as a TEST SEAM: the delete flow that opens it is hidden behind
/// `Visibility(visible: false)` today, so the only way to pump this dialog — and
/// prove its content still reaches a 320dp screen with the keyboard up — is to
/// show it directly.
@visibleForTesting
class DeleteOtpDialog extends StatefulWidget {
  const DeleteOtpDialog({super.key});

  @override
  State<DeleteOtpDialog> createState() => _DeleteOtpDialogState();
}

class _DeleteOtpDialogState extends State<DeleteOtpDialog> {
  final TextEditingController _otp = TextEditingController();
  Timer? _timer;
  int _remaining = 0;

  @override
  void initState() {
    super.initState();
    _remaining = context.read<AccountDeleteCubit>().state.resendInSeconds;
    _startCountdown();
  }

  void _startCountdown() {
    _timer?.cancel();
    if (_remaining <= 0) return;
    _timer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      if (!mounted) return;
      setState(() => _remaining = _remaining > 0 ? _remaining - 1 : 0);
      if (_remaining <= 0) t.cancel();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _otp.dispose();
    super.dispose();
  }

  /// #361 — the REAL resend. Re-hits the same step-up OTP request the pre-dialog
  /// flow used (POST /auth/account/delete/request); the listener below restarts
  /// the countdown off the fresh cooldown when it lands, and a failure (e.g. 429)
  /// surfaces inline through the existing error line. Not awaited on purpose:
  /// the cubit is the single source of truth for this dialog's state.
  void _resend(BuildContext context) {
    unawaited(context.read<AccountDeleteCubit>().requestDelete());
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<AccountDeleteCubit, AccountDeleteState>(
      listener: (BuildContext context, AccountDeleteState state) {
        if (state.status == AccountDeleteStatus.scheduled) {
          Navigator.of(context).pop(true);
          return;
        }
        // #361 — a successful resend hands back a NEW cooldown; restart the
        // countdown from it so the control re-arms only when the server allows
        // another send. (Only fires on a transition, so the initial otpSent the
        // dialog opens on is already covered by initState.)
        if (state.status == AccountDeleteStatus.otpSent) {
          setState(() => _remaining = state.resendInSeconds);
          _startCountdown();
        }
      },
      builder: (BuildContext context, AccountDeleteState state) {
        final bool sending = state.status == AccountDeleteStatus.sendingOtp;
        final bool busy =
            state.status == AccountDeleteStatus.confirming || sending;
        final bool isError = state.status == AccountDeleteStatus.error;
        return AlertDialog(
          backgroundColor: OnboardingColors.paperWhite,
          // Design law: separation is the scrim + fill, never a shadow.
          elevation: 0,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.all(
              Radius.circular(OnboardingRadii.card),
            ),
          ),
          titlePadding: const EdgeInsets.fromLTRB(24, 24, 24, 12),
          contentPadding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
          title: Text(
            'OTP daalein',
            style: OnboardingTypography.anek(size: 18, weight: FontWeight.w800),
          ),
          // `scrollable: true` scrolls the TITLE together with the content, and
          // that is the point. At 320x568 with a 2.0 system font and the keyboard
          // up, this dialog has about 260dp of height: the PINNED title plus the
          // two action buttons (which stack at that scale) overflowed it by 60dp
          // on their own. Scrolling only the content could not have fixed that —
          // the content was already free to shrink — and an OTP field the worker
          // cannot reach dead-ends the legally-required DPDP deletion flow.
          scrollable: true,
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'Aapke phone par bheja gaya OTP daalein — verify hote hi account '
                '7 din mein delete ho jaayega.',
                style: OnboardingTypography.inter(
                  size: 14,
                  height: 1.45,
                  color: OnboardingColors.ink600,
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _otp,
                autofocus: true,
                enabled: !busy,
                keyboardType: TextInputType.number,
                maxLength: 8,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                ],
                // A code is mono (spec §1.2), so a 6 and a 5 cannot be
                // mistaken for one another while reading it off an SMS.
                style: OnboardingTypography.mono(
                  size: 16,
                  weight: FontWeight.w700,
                  color: OnboardingColors.ink900,
                ),
                decoration: const InputDecoration(
                  counterText: '',
                  hintText: 'OTP',
                ),
                // Rebuild so the "Delete karein" button enables at ≥4 digits
                // and the inline error hint clears as the worker re-types.
                onChanged: (_) => setState(() {}),
              ),
              if (isError) ...<Widget>[
                const SizedBox(height: 8),
                Text(
                  failureReason(state.failure).reason,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w500,
                    color: OnboardingColors.errorRed,
                  ),
                ),
              ],
              const SizedBox(height: 8),
              // #361 — while the cooldown runs this is (correctly) just a
              // countdown caption; the moment it elapses it becomes a REAL
              // tappable resend. It used to swap to the plain text "Naya OTP
              // bhej sakte hain", which promised an affordance that did not
              // exist — a lost delete-OTP dead-ended the legally-required DPDP
              // deletion flow behind copy telling the worker to do something
              // the dialog gave them no way to do.
              if (_remaining > 0)
                Text(
                  'Dobara bhejne ke liye $_remaining second',
                  style: OnboardingTypography.inter(
                    size: 12,
                    color: OnboardingColors.ink500,
                  ),
                )
              else
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    style: TextButton.styleFrom(
                      foregroundColor: OnboardingColors.shiftBlue,
                      textStyle: OnboardingTypography.inter(
                        size: 13,
                        weight: FontWeight.w700,
                        color: OnboardingColors.shiftBlue,
                      ),
                      minimumSize: const Size(
                        OnboardingLayout.tapTarget,
                        OnboardingLayout.tapTarget,
                      ),
                      tapTargetSize: MaterialTapTargetSize.padded,
                    ),
                    // Disabled mid-flight so a double tap can't burn two OTPs
                    // (and trip the server's rate limit against the worker).
                    onPressed: busy ? null : () => _resend(context),
                    child: sending
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: OnboardingColors.shiftBlue,
                            ),
                          )
                        : const Text('Dobara OTP bhejein'),
                  ),
                ),
            ],
          ),
          actions: <Widget>[
            TextButton(
              style: TextButton.styleFrom(
                foregroundColor: OnboardingColors.ink600,
                textStyle: OnboardingTypography.inter(
                  size: 14,
                  weight: FontWeight.w700,
                  color: OnboardingColors.ink600,
                ),
                minimumSize: const Size(
                  OnboardingLayout.tapTarget,
                  OnboardingLayout.tapTarget,
                ),
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              onPressed: busy ? null : () => Navigator.of(context).pop(false),
              child: const Text('Rehne dein'),
            ),
            TextButton(
              style: TextButton.styleFrom(
                foregroundColor: OnboardingColors.errorRed,
                textStyle: OnboardingTypography.inter(
                  size: 14,
                  weight: FontWeight.w700,
                  color: OnboardingColors.errorRed,
                ),
                minimumSize: const Size(
                  OnboardingLayout.tapTarget,
                  OnboardingLayout.tapTarget,
                ),
                tapTargetSize: MaterialTapTargetSize.padded,
              ),
              onPressed: (busy || _otp.text.length < 4)
                  ? null
                  : () => context.read<AccountDeleteCubit>().confirmDelete(
                      _otp.text,
                    ),
              // #361 — spinner only for the CONFIRM round trip. `busy` also
              // covers a resend, and showing two spinners at once would read as
              // "the delete is going through" while nothing is being confirmed.
              child: state.status == AccountDeleteStatus.confirming
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: OnboardingColors.errorRed,
                      ),
                    )
                  : const Text('Delete karein'),
            ),
          ],
        );
      },
    );
  }
}

/// Settings → Privacy: the DPDP "withdraw consent" row.
///
/// Withdrawal is a session-ending action on the server (`POST /consent/withdraw`
/// revokes the consent record AND every session — this device included), so a
/// success drives a hard-logout via [ConsentWithdrawCubit] and the router bounces
/// to phone login; the honest confirm copy states exactly that. A failure is
/// surfaced as the app's centred alert with the real reason (never a generic
/// "kuch gadbad").
class _WithdrawConsentRow extends StatelessWidget {
  const _WithdrawConsentRow();

  /// Non-dismissible confirm — a destructive, legally-meaningful action a
  /// low-literacy worker must read, not tap past. States the real consequence
  /// learned from the backend: all devices logged out + re-login + re-consent.
  ///
  /// The copy is the APPROVED DPDP wording and is kept verbatim.
  Future<void> _confirm(BuildContext context) async {
    final ConsentWithdrawCubit cubit = context.read<ConsentWithdrawCubit>();
    final bool proceed = await showBbConfirm(
      context,
      title: 'Consent wapas lein?',
      message:
          'Consent wapas lene par aapki profiling band ho jaayegi aur aap '
          'sabhi devices se logout ho jaayenge. App dobara use karne ke liye '
          'phir se login karke consent dena hoga.',
      confirmLabel: 'Consent wapas lein',
      destructive: true,
      barrierDismissible: false,
    );
    if (!proceed) return;
    await cubit.withdraw();
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ConsentWithdrawCubit, ConsentWithdrawState>(
      // Only the failure path needs a listener: on success the server has
      // revoked every session and the cubit hard-logs-out, so the router tears
      // this screen down — there is nothing to show here.
      listenWhen: (ConsentWithdrawState prev, ConsentWithdrawState curr) =>
          curr.status == ConsentWithdrawStatus.failure,
      listener: (BuildContext context, ConsentWithdrawState state) {
        showBbAlert(
          context,
          title: 'Consent wapas nahi liya ja saka',
          message: failureReason(state.failure).reason,
        );
      },
      builder: (BuildContext context, ConsentWithdrawState state) {
        final Widget row = BbListRow.setting(
          icon: Icons.gpp_maybe_outlined,
          title: 'Consent wapas lein',
          subtitle: 'Profiling band · sabhi devices se logout',
          danger: true,
          onTap: state.isSubmitting ? null : () => _confirm(context),
        );
        // Dim + block while the withdraw round trip is in flight, mirroring the
        // account-delete row's in-flight treatment.
        if (state.isSubmitting) {
          return const IgnorePointer(
            child: Opacity(opacity: 0.45, child: _SubmittingWithdrawRow()),
          );
        }
        return row;
      },
    );
  }
}

/// The dimmed placeholder shown while a consent withdrawal is in flight — same
/// row, no tap, so the worker sees the action is working, not frozen.
class _SubmittingWithdrawRow extends StatelessWidget {
  const _SubmittingWithdrawRow();

  @override
  Widget build(BuildContext context) {
    return BbListRow.setting(
      icon: Icons.gpp_maybe_outlined,
      title: 'Consent wapas liya ja raha hai…',
      subtitle: 'Profiling band · sabhi devices se logout',
      danger: true,
    );
  }
}

/// E0 C-2 (#1630): the PER-PURPOSE exit from employer contact — NOT the
/// all-or-nothing [_WithdrawConsentRow] above. This keeps the worker's profile,
/// resume and voice, and does NOT log him out. Confirm-before-write; the state
/// is read from the server on mount and re-read after the write (never
/// optimistic-only), so the switch can only render server truth.
class _EmployerContactRow extends StatelessWidget {
  const _EmployerContactRow();

  Future<void> _confirmAndWithdraw(BuildContext context) async {
    final EmployerContactCubit cubit = context.read<EmployerContactCubit>();
    final bool proceed = await showBbConfirm(
      context,
      title: 'Employer contact band karein?',
      message:
          'Iske baad employer aapko contact nahi kar payenge. Aapka profile, '
          'resume aur login waisa hi rahega — aap logout nahi honge.',
      confirmLabel: 'Haan, band karein',
      destructive: true,
      barrierDismissible: false,
    );
    if (!proceed || !context.mounted) return;
    await cubit.withdraw();
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<EmployerContactCubit, EmployerContactState>(
      listenWhen: (EmployerContactState prev, EmployerContactState curr) =>
          curr.status == EmployerContactStatus.failed,
      listener: (BuildContext context, EmployerContactState state) {
        showBbAlert(
          context,
          title: 'Employer contact band nahi ho saka',
          message: failureReason(state.failure).reason,
        );
      },
      builder: (BuildContext context, EmployerContactState state) {
        final bool loading =
            state.status == EmployerContactStatus.loading;
        final bool submitting =
            state.status == EmployerContactStatus.submitting;
        final bool failed = state.status == EmployerContactStatus.failed;
        final String subtitle = loading || submitting
            ? 'Update ho raha hai…'
            : failed
                ? 'Status pata nahi chala'
                : state.enabled
                    ? 'Employer abhi aapko contact kar sakte hain'
                    : 'Employer contact band hai';
        return BbListRow.toggle(
          icon: Icons.do_not_disturb_on_outlined,
          title: 'Employer contact band karein',
          subtitle: subtitle,
          value: state.enabled,
          // Only the ON → OFF direction exists: re-enabling is the consent
          // notice's job, not this switch's.
          enabled: state.status == EmployerContactStatus.ready && state.enabled,
          onChanged: (_) => _confirmAndWithdraw(context),
        );
      },
    );
  }
}

/// Settings → Notifications: the master on/off slide switch. OFF = the worker
/// receives NO push notifications; ON = all types. Reads its initial value from
/// [NotificationPrefsRepository] (server-preferred, local fallback, default ON)
/// and writes the choice back on every flip — local instantly, server best-effort.
class _NotificationsToggleRow extends StatefulWidget {
  const _NotificationsToggleRow();

  @override
  State<_NotificationsToggleRow> createState() =>
      _NotificationsToggleRowState();
}

class _NotificationsToggleRowState extends State<_NotificationsToggleRow> {
  NotificationPrefsRepository get _repo =>
      locator<NotificationPrefsRepository>();

  // Optimistic default ON until the async load resolves — the app's baseline is
  // "notifications on", so this never briefly shows a wrong OFF.
  bool _enabled = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final bool value = await _repo.isEnabled();
    if (mounted) setState(() => _enabled = value);
  }

  void _onChanged(bool value) {
    setState(() => _enabled = value); // optimistic — the write never throws
    _repo.setEnabled(value);
  }

  @override
  Widget build(BuildContext context) {
    return BbListRow.toggle(
      icon: Icons.notifications_outlined,
      title: 'Notifications',
      // OFF must not overpromise: security alerts (login / logout-all) always
      // arrive so a worker who turns notifications off and still gets a
      // SIM-swap alarm doesn't think the toggle is broken (#648).
      subtitle: _enabled
          ? 'On — sabhi alerts milenge'
          : 'Off — sirf suraksha alerts aayenge',
      value: _enabled,
      onChanged: _onChanged,
    );
  }
}
