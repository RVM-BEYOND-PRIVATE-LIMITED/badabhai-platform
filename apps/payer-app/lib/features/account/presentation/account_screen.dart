import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/payer_account_api.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_card.dart';
import '../../capacity/presentation/capacity_screen.dart';
import '../../org/presentation/team_screen.dart';
import 'cubit/account_cubit.dart';

/// Account — the real `GET /payer/me` identity (org · email · role · status ·
/// masked phone), an edit affordance (`PATCH /payer/me`, changed fields only),
/// and a danger-red Sign out that runs the C1 revoke-and-wipe path.
///
/// PII discipline: only `phoneLast4` is ever rendered or held — a full phone is
/// accepted transiently in the edit sheet and handed straight to the PATCH.
class AccountScreen extends StatelessWidget {
  const AccountScreen({
    super.key,
    required this.session,
    required this.onSignOut,
  });

  final AppSession session;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AccountCubit>(
      create: (_) => locator<AccountCubit>()..load(),
      child: _AccountView(session: session, onSignOut: onSignOut),
    );
  }
}

class _AccountView extends StatelessWidget {
  const _AccountView({required this.session, required this.onSignOut});

  final AppSession session;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<AccountCubit, AccountState>(
      builder: (BuildContext context, AccountState state) {
        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s3,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Text(
              'Account',
              style: AppTypography.display(
                size: AppTypography.sizeXl,
                weight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: AppSpacing.s4),
            if (state.status == AccountStatus.loading && state.me == null)
              const _LoadingCard()
            else if (state.status == AccountStatus.error && state.me == null)
              _ErrorCard(
                message: state.error ??
                    'Could not load your account. Retry in a moment.',
                onRetry: () => context.read<AccountCubit>().load(),
              )
            else ...<Widget>[
              _IdentityCard(me: state.me, fallback: session.account),
              const SizedBox(height: AppSpacing.s3),
              _DetailsCard(me: state.me),
              if (state.status == AccountStatus.error && state.error != null)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.s2),
                  child: Text(
                    state.error!,
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.danger,
                    ),
                  ),
                ),
            ],
            const SizedBox(height: AppSpacing.s3),
            BbCard(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
              child: Column(
                children: <Widget>[
                  _SettingsRow(
                    icon: Icons.edit_outlined,
                    label: 'Edit account',
                    onTap: state.me == null
                        ? null
                        : () => _openEdit(context, state.me!),
                  ),
                  _SettingsRow(
                    icon: Icons.groups_outlined,
                    label: 'Team',
                    onTap: () => _openTeam(context),
                  ),
                  _SettingsRow(
                    icon: Icons.tune,
                    label: 'Hiring capacity',
                    onTap: () => _openCapacity(context),
                  ),
                  const _SettingsRow(
                    icon: Icons.verified_user_outlined,
                    label: 'Privacy & DPDP consent',
                  ),
                  _SettingsRow(
                    icon: Icons.logout,
                    label: 'Sign out',
                    danger: true,
                    showBorder: false,
                    showChevron: false,
                    onTap: onSignOut,
                  ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  /// Team / org members (ADR-0027) — pushed as a full page with its own back.
  void _openTeam(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const TeamScreen()),
    );
  }

  /// Hiring capacity (ADR-0016) — pushed as a full page with its own back.
  void _openCapacity(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => const CapacityScreen()),
    );
  }

  Future<void> _openEdit(BuildContext context, PayerMe me) async {
    final AccountCubit cubit = context.read<AccountCubit>();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceCard,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
      ),
      builder: (BuildContext sheetContext) =>
          _EditSheet(me: me, cubit: cubit),
    );
  }
}

/// The edit sheet — `PATCH /payer/me` with ONLY changed fields. Org name is
/// prefilled; phone is a fresh E164 entry (never prefilled, never stored — only
/// the masked last-4 is ever shown, so we cannot reconstruct the current phone).
class _EditSheet extends StatefulWidget {
  const _EditSheet({required this.me, required this.cubit});

  final PayerMe me;
  final AccountCubit cubit;

  @override
  State<_EditSheet> createState() => _EditSheetState();
}

class _EditSheetState extends State<_EditSheet> {
  late final TextEditingController _org =
      TextEditingController(text: widget.me.orgName);
  final TextEditingController _phone = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _org.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final String org = _org.text.trim();
    final String phone = _phone.text.trim();
    // Send ONLY what actually changed — an empty/no-op PATCH is a 400.
    final String? orgChanged =
        (org.isNotEmpty && org != widget.me.orgName) ? org : null;
    final String? phoneChanged = phone.isNotEmpty ? phone : null;
    if (orgChanged == null && phoneChanged == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() => _saving = true);
    await widget.cubit.updateMe(orgName: orgChanged, phone: phoneChanged);
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final double bottomInset = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s5,
        AppSpacing.gutter,
        AppSpacing.s5 + bottomInset,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Edit account',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          _FieldLabel('Company / org name'),
          const SizedBox(height: AppSpacing.s1),
          TextField(
            controller: _org,
            textCapitalization: TextCapitalization.words,
            style: AppTypography.body(size: AppTypography.sizeBase),
            decoration: _inputDecoration('Your organisation'),
          ),
          const SizedBox(height: AppSpacing.s4),
          _FieldLabel('New phone (optional)'),
          const SizedBox(height: AppSpacing.s1),
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            style: AppTypography.mono(size: AppTypography.sizeBase),
            decoration: _inputDecoration('+91XXXXXXXXXX'),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'We only ever show the last 4 digits.',
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          SizedBox(
            width: double.infinity,
            height: AppSpacing.controlLg,
            child: FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: AppColors.textOnBrand,
                      ),
                    )
                  : const Text('Save changes'),
            ),
          ),
        ],
      ),
    );
  }

  InputDecoration _inputDecoration(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: AppTypography.body(color: AppColors.textFaint),
        filled: true,
        fillColor: AppColors.surfaceSunken,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s4,
          vertical: AppSpacing.s3,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.md),
          borderSide: BorderSide.none,
        ),
      );
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Text(
        text,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          weight: FontWeight.w600,
          color: AppColors.textSecondary,
        ),
      );
}

class _IdentityCard extends StatelessWidget {
  const _IdentityCard({required this.me, required this.fallback});

  final PayerMe? me;
  final PayerAccount fallback;

  @override
  Widget build(BuildContext context) {
    final String orgName = me?.orgName.isNotEmpty == true
        ? me!.orgName
        : fallback.name;
    final String subline = me == null
        ? fallback.plan
        : '${_roleLabel(me!.role)} · ${_statusLabel(me!.status)}';
    return BbCard(
      child: Row(
        children: <Widget>[
          BbAvatar(initials: _initials(orgName), size: 54),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  orgName,
                  style: AppTypography.display(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w700,
                  ),
                ),
                Text(
                  subline,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
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

class _DetailsCard extends StatelessWidget {
  const _DetailsCard({required this.me});

  final PayerMe? me;

  @override
  Widget build(BuildContext context) {
    final PayerMe? m = me;
    return BbCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
      child: Column(
        children: <Widget>[
          _InfoRow(
            icon: Icons.mail_outline,
            label: 'Email',
            value: m?.email.isNotEmpty == true ? m!.email : '—',
          ),
          _InfoRow(
            icon: Icons.phone_outlined,
            label: 'Phone',
            value: _maskedPhone(m?.phoneLast4),
            mono: true,
          ),
          _InfoRow(
            icon: Icons.badge_outlined,
            label: 'Status',
            value: m == null ? '—' : _statusLabel(m.status),
            showBorder: false,
          ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({
    required this.icon,
    required this.label,
    required this.value,
    this.mono = false,
    this.showBorder = true,
  });

  final IconData icon;
  final String label;
  final String value;
  final bool mono;
  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      constraints: const BoxConstraints(minHeight: AppSpacing.tap),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 22, color: AppColors.textMuted),
          const SizedBox(width: AppSpacing.s3),
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeBase,
              color: AppColors.textSecondary,
            ),
          ),
          const Spacer(),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              overflow: TextOverflow.ellipsis,
              style: mono
                  ? AppTypography.mono(size: AppTypography.sizeSm)
                  : AppTypography.body(
                      size: AppTypography.sizeSm,
                      weight: FontWeight.w600,
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _LoadingCard extends StatelessWidget {
  const _LoadingCard();

  @override
  Widget build(BuildContext context) => const BbCard(
        child: SizedBox(
          height: 72,
          child: Center(
            child: CircularProgressIndicator(color: AppColors.brand),
          ),
        ),
      );
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => BbCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              message,
              style: AppTypography.body(
                size: AppTypography.sizeBase,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            SizedBox(
              height: AppSpacing.tap,
              child: OutlinedButton(
                onPressed: onRetry,
                child: const Text('Retry'),
              ),
            ),
          ],
        ),
      );
}

class _SettingsRow extends StatelessWidget {
  const _SettingsRow({
    required this.icon,
    required this.label,
    this.danger = false,
    this.showBorder = true,
    this.showChevron = true,
    this.onTap,
  });

  final IconData icon;
  final String label;
  final bool danger;
  final bool showBorder;
  final bool showChevron;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final Color color = danger ? AppColors.danger : AppColors.textPrimary;
    final Color iconColor = danger ? AppColors.danger : AppColors.textMuted;

    final Widget row = Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      constraints: const BoxConstraints(minHeight: AppSpacing.tap),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 22, color: iconColor),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Text(
              label,
              style: AppTypography.body(
                size: AppTypography.sizeBase,
                color: color,
              ),
            ),
          ),
          if (showChevron)
            const Icon(Icons.chevron_right,
                size: 20, color: AppColors.textFaint),
        ],
      ),
    );

    if (onTap == null) return row;
    return Material(
      type: MaterialType.transparency,
      child: InkWell(onTap: onTap, child: row),
    );
  }
}

/// Initials for the avatar — first letter of the first two words of the org.
String _initials(String orgName) {
  final List<String> parts =
      orgName.trim().split(RegExp(r'\s+')).where((String p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) {
    return parts.first.substring(0, 1).toUpperCase();
  }
  return (parts[0].substring(0, 1) + parts[1].substring(0, 1)).toUpperCase();
}

/// `employer` → Company, `agent` → Agency (matches the wire role).
String _roleLabel(String role) => role == 'agent' ? 'Agency' : 'Company';

String _statusLabel(String status) => status.isEmpty
    ? '—'
    : status[0].toUpperCase() + status.substring(1);

/// Renders ONLY the masked last-4 — never a full phone.
String _maskedPhone(String? last4) =>
    (last4 != null && last4.isNotEmpty) ? '•••• $last4' : '—';
