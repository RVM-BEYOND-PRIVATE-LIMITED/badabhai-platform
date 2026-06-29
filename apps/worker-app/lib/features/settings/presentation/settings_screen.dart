import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';

/// Settings (spec §5.10). For the alpha the rows are mostly inert — a tap shows
/// a "coming soon" snackbar — and account-delete is a stub dialog explaining the
/// 7-day grace; real DPDP delete + data-export are deferred (§7).
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  void _comingSoon(BuildContext context) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(const SnackBar(content: Text('Jald aa raha hai')));
  }

  Future<void> _confirmDelete(BuildContext context) async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('Account delete karein?'),
        content: const Text(
          'OTP verify karne ke baad aapka account 7 din mein delete ho jaata '
          'hai. Is dauraan aap kabhi bhi cancel kar sakte hain.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Rehne dein'),
          ),
          TextButton(
            onPressed: () {
              Navigator.of(dialogContext).pop();
              // Real DPDP account-delete is deferred (§7) — stub only.
              _comingSoon(context);
            },
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            child: const Text('Delete karein'),
          ),
        ],
      ),
    );
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
