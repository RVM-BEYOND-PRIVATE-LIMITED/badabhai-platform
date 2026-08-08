import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/remote_config.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/date_label.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/notification_prefs_repository.dart';
import 'cubit/account_delete_cubit.dart';

/// Settings (spec §5.10). Most rows are inert for the alpha (a tap shows a
/// "coming soon" snackbar). Account-delete is hidden for now; the DPDP
/// 2-step flow (A4 + ADR-0031 grace window) will return once the delete
/// experience is redesigned.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    // Screen-scoped cubit: seeds `scheduled` from the SessionRepository when a
    // deletion is already pending (e.g. after a login during the grace), so
    // the banner shows without any network call.
    return BlocProvider<AccountDeleteCubit>(
      create: (_) => locator<AccountDeleteCubit>(),
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
    final bool proceed = await showDialog<bool>(
          context: context,
          builder: (BuildContext dialogContext) => AlertDialog(
            title: const Text('Account delete karein?'),
            content: const Text(
              'OTP verify karne ke baad aapka account 7 din mein delete ho jaata '
              'hai. Is dauraan aap kabhi bhi cancel kar sakte hain.',
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                child: const Text('Rehne dein'),
              ),
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(true),
                style: TextButton.styleFrom(foregroundColor: AppColors.danger),
                child: const Text('Delete karein'),
              ),
            ],
          ),
        ) ??
        false;
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
            SnackBar(content: Text(failureReason(s.failure).reason)));
      return;
    }

    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext dialogContext) => BlocProvider<AccountDeleteCubit>.value(
        value: cubit,
        child: const _DeleteOtpDialog(),
      ),
    );
  }

  /// A settings group card — white paper, one hairline border, no shadow; the
  /// rows supply their own dividers (kit grouped-list idiom).
  Widget _group(List<Widget> rows) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(children: rows),
    );
  }

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Settings'),
      padded: false,
      body: ListView(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.gutter,
          vertical: AppSpacing.s4,
        ),
        children: <Widget>[
          // HIDDEN FOR NOW: the 'Bhasha' language row — hidden across the app
          // until real localization ships (the picker only ever set `X-Locale`,
          // with no translated strings behind it). Restore it with the splash
          // picker.
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
                onTap: () => context.push(Routes.invite),
              ),
            BbListRow.setting(
              icon: Icons.chat,
              title: 'WhatsApp alerts',
              subtitle: 'Job alert · resume · reply',
              onTap: () => _comingSoon(context),
            ),
            const _NotificationsToggleRow(),
          ]),
          const SizedBox(height: AppSpacing.s4),
          _group(<Widget>[
            // #464 — RESTORED. The worker's only in-app way to kick a lost or
            // stolen handset off their account (the emit-after-close crash in
            // DevicesCubit.load, FI-001, that got it removed is now guarded at
            // its source — DevicesScreen / Routes.devices are reachable again).
            BbListRow.setting(
              icon: Icons.devices_other_outlined,
              title: 'Aapke devices',
              subtitle: 'Logged-in devices dekhein · hatayein',
              onTap: () => context.push(Routes.devices),
            ),
            BbListRow.setting(
              icon: Icons.verified_user_outlined,
              title: 'Privacy & data',
              subtitle: 'Consent · download · delete',
              onTap: () => _comingSoon(context),
            ),
          ]),
          // Account delete hidden for now; will return after the flow is redesigned.
          Visibility(
            visible: false,
            maintainState: true,
            child: BlocConsumer<AccountDeleteCubit, AccountDeleteState>(
              // React only to the cancel round trip resolving (cancelling →
              // idle/scheduled) — the OTP dialog owns its own error surface.
              listenWhen: (AccountDeleteState prev, AccountDeleteState curr) =>
                  prev.status == AccountDeleteStatus.cancelling &&
                  curr.status != AccountDeleteStatus.cancelling,
              listener: (BuildContext context, AccountDeleteState state) {
                final ScaffoldMessengerState messenger =
                    ScaffoldMessenger.of(context)..clearSnackBars();
                if (state.status == AccountDeleteStatus.idle) {
                  messenger.showSnackBar(const SnackBar(
                      content: Text('Account delete cancel ho gaya')));
                } else {
                  // Cancel failed — the honest reason; the banner stays.
                  messenger.showSnackBar(SnackBar(
                      content: Text(failureReason(state.failure).reason)));
                }
              },
              builder: (BuildContext context, AccountDeleteState state) {
                final bool pending =
                    state.status == AccountDeleteStatus.scheduled ||
                        state.status == AccountDeleteStatus.cancelling;
                if (!pending) {
                  final bool requestInProgress = state.status ==
                          AccountDeleteStatus.sendingOtp ||
                      state.status == AccountDeleteStatus.otpSent ||
                      state.status == AccountDeleteStatus.confirming;
                  final Widget row = BbListRow.setting(
                    icon: Icons.delete_outline,
                    title: 'Account delete karein',
                    subtitle: 'OTP ke baad 7 din mein',
                    onTap: requestInProgress ? null : () => _confirmDelete(context),
                  );
                  if (requestInProgress) {
                    return IgnorePointer(
                      child: Opacity(
                        opacity: 0.45,
                        child: row,
                      ),
                    );
                  }
                  return row;
                }
                return _PendingDeletionBanner(state: state);
              },
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          Text(
            'BadaBhai · v1.0 · Made in India',
            textAlign: TextAlign.center,
            style: AppTypography.body(
                size: AppTypography.sizeXs, color: AppColors.textFaint),
          ),
        ],
      ),
    );
  }
}

/// The grace-window banner that replaces the delete row while a deletion is
/// pending (ADR-0031): when the account will be deleted + the explicit
/// "Delete cancel karein" action. Neutral brand surface with ink text,
/// mirroring the non-danger treatment of the delete row.
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
    return Container(
      margin: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s4, vertical: AppSpacing.s2),
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: AppColors.brandTint,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: AppColors.brand),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.mediation, color: AppColors.brand),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  line,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w600,
                    color: AppColors.ink800,
                  ),
                ),
                Text(
                  'Aap is dauraan cancel kar sakte hain',
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: AppColors.brand),
            onPressed: cancelling
                ? null
                : () => context.read<AccountDeleteCubit>().cancelDelete(),
            child: cancelling
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Delete cancel karein'),
          ),
        ],
      ),
    );
  }
}

/// The OTP-entry step of account delete. Reacts to [AccountDeleteCubit]: shows a
/// countdown from the resend cooldown, offers a REAL resend once it elapses,
/// submits the OTP, surfaces the honest error (bad OTP / rate-limit), and pops
/// once the delete is SCHEDULED (the banner behind it takes over).
class _DeleteOtpDialog extends StatefulWidget {
  const _DeleteOtpDialog();

  @override
  State<_DeleteOtpDialog> createState() => _DeleteOtpDialogState();
}

class _DeleteOtpDialogState extends State<_DeleteOtpDialog> {
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
          title: const Text('OTP daalein'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Text(
                'Aapke phone par bheja gaya OTP daalein — verify hote hi account '
                '7 din mein delete ho jaayega.',
              ),
              const SizedBox(height: AppSpacing.s3),
              TextField(
                controller: _otp,
                autofocus: true,
                enabled: !busy,
                keyboardType: TextInputType.number,
                maxLength: 8,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                ],
                style: AppTypography.mono(),
                decoration: const InputDecoration(
                  counterText: '',
                  hintText: 'OTP',
                ),
                // Rebuild so the "Delete karein" button enables at ≥4 digits
                // and the inline error hint clears as the worker re-types.
                onChanged: (_) => setState(() {}),
              ),
              if (isError) ...<Widget>[
                const SizedBox(height: AppSpacing.s2),
                Text(
                  failureReason(state.failure).reason,
                  style: AppTypography.body(
                      size: AppTypography.sizeSm, color: AppColors.danger),
                ),
              ],
              const SizedBox(height: AppSpacing.s2),
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
                  style: AppTypography.body(
                      size: AppTypography.sizeXs, color: AppColors.textFaint),
                )
              else
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    // Disabled mid-flight so a double tap can't burn two OTPs
                    // (and trip the server's rate limit against the worker).
                    onPressed: busy ? null : () => _resend(context),
                    child: sending
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Dobara OTP bhejein'),
                  ),
                ),
            ],
          ),
          actions: <Widget>[
            TextButton(
              onPressed: busy ? null : () => Navigator.of(context).pop(false),
              child: const Text('Rehne dein'),
            ),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: AppColors.danger),
              onPressed: (busy || _otp.text.length < 4)
                  ? null
                  : () =>
                      context.read<AccountDeleteCubit>().confirmDelete(_otp.text),
              // #361 — spinner only for the CONFIRM round trip. `busy` also
              // covers a resend, and showing two spinners at once would read as
              // "the delete is going through" while nothing is being confirmed.
              child: state.status == AccountDeleteStatus.confirming
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Delete karein'),
            ),
          ],
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
  NotificationPrefsRepository get _repo => locator<NotificationPrefsRepository>();

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
