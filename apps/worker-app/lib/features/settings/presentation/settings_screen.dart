import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import 'cubit/account_delete_cubit.dart';

/// Settings (spec §5.10). Most rows are inert for the alpha (a tap shows a
/// "coming soon" snackbar). Account-delete is the real DPDP 2-step flow (A4):
/// confirm → request OTP → enter OTP → on 204, wipe local credentials and return
/// to phone login. Real data-export is still deferred (§7).
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

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
  /// reason on a request failure instead of silently dead-ending.
  Future<void> _startDeleteOtpFlow(BuildContext context) async {
    final AccountDeleteCubit cubit = locator<AccountDeleteCubit>();
    await cubit.requestDelete();
    if (!context.mounted) {
      await cubit.close();
      return;
    }
    final AccountDeleteState s = cubit.state;
    if (s.status != AccountDeleteStatus.otpSent) {
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(
            SnackBar(content: Text(failureReason(s.failure).reason)));
      await cubit.close();
      return;
    }

    final bool? deleted = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext dialogContext) => BlocProvider<AccountDeleteCubit>.value(
        value: cubit,
        child: const _DeleteOtpDialog(),
      ),
    );
    await cubit.close();

    if (deleted == true && context.mounted) {
      // Credentials are already wiped by the cubit; leave the shell for login.
      context.go(Routes.phoneLogin);
    }
  }

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Settings'),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s2),
        children: <Widget>[
          BbListRow.setting(
            icon: Icons.translate,
            title: 'Bhasha',
            subtitle: 'हिंदी',
            onTap: () => _comingSoon(context),
          ),
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
          BbListRow.setting(
            icon: Icons.notifications_outlined,
            title: 'Notifications',
            subtitle: 'On',
            onTap: () => _comingSoon(context),
          ),
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
          BbListRow.setting(
            icon: Icons.delete_outline,
            title: 'Account delete karein',
            subtitle: 'OTP ke baad 7 din mein',
            danger: true,
            onTap: () => _confirmDelete(context),
          ),
          const SizedBox(height: AppSpacing.s5),
          Text(
            'BadaBhai · v1.0 · Made in India 🇮🇳',
            textAlign: TextAlign.center,
            style: AppTypography.body(
                size: AppTypography.sizeXs, color: AppColors.textFaint),
          ),
        ],
      ),
    );
  }
}

/// The OTP-entry step of account delete. Reacts to [AccountDeleteCubit]: shows a
/// countdown from the resend cooldown, submits the OTP, surfaces the honest error
/// (bad OTP / rate-limit), and pops `true` once the delete is confirmed.
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

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<AccountDeleteCubit, AccountDeleteState>(
      listener: (BuildContext context, AccountDeleteState state) {
        if (state.status == AccountDeleteStatus.deleted) {
          Navigator.of(context).pop(true);
        }
      },
      builder: (BuildContext context, AccountDeleteState state) {
        final bool busy = state.status == AccountDeleteStatus.confirming ||
            state.status == AccountDeleteStatus.sendingOtp;
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
              Text(
                _remaining > 0
                    ? 'Dobara bhejne ke liye $_remaining second'
                    : 'Naya OTP bhej sakte hain',
                style: AppTypography.body(
                    size: AppTypography.sizeXs, color: AppColors.textFaint),
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
              child: busy
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
