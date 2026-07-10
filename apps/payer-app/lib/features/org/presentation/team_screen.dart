import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/org_cubit.dart';

/// Team / Org members (ADR-0027). Lists the caller's org members (masked email +
/// role/status chips + a "You" tag), and — for an OWNER session only — an
/// "Invite recruiter" action and a per-member Remove. Anyone can "Accept invite"
/// with a token. Owner-only affordances are hidden for a recruiter session
/// (derived from the members list); the server also 403s, surfaced honestly.
class TeamScreen extends StatelessWidget {
  const TeamScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<OrgCubit>(
      create: (_) => locator<OrgCubit>()..load(),
      child: const _TeamView(),
    );
  }
}

class _TeamView extends StatelessWidget {
  const _TeamView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(
        child: BlocBuilder<OrgCubit, OrgState>(
          builder: (BuildContext context, OrgState state) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                _Header(onBack: () => Navigator.of(context).pop()),
                Expanded(child: _body(context, state)),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _body(BuildContext context, OrgState state) {
    if (state.status == OrgStatus.loading || state.status == OrgStatus.initial) {
      return const BbStatusView.loading();
    }
    if (state.status == OrgStatus.error && state.members.isEmpty) {
      return BbStatusView(
        icon: Icons.wifi_off,
        title: 'Could not load your team',
        subtitle: state.error,
        action: BbButton(
          label: 'Retry',
          onPressed: () => context.read<OrgCubit>().load(),
        ),
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      children: <Widget>[
        if (state.isOwner) ...<Widget>[
          BbButton(
            label: 'Invite recruiter',
            iconLeft: Icons.person_add_alt,
            block: true,
            onPressed: () => _openInvite(context),
          ),
          const SizedBox(height: AppSpacing.s4),
        ],
        Text(
          'Members',
          style: AppTypography.display(
            size: AppTypography.sizeBase,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        BbCard(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
          child: Column(
            children: <Widget>[
              for (int i = 0; i < state.members.length; i++)
                _MemberRow(
                  member: state.members[i],
                  canRemove: state.isOwner && !state.members[i].isOwner,
                  showBorder: i < state.members.length - 1,
                  onRemove: () => _confirmRemove(context, state.members[i]),
                ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s5),
        Text(
          'Have an invite?',
          style: AppTypography.display(
            size: AppTypography.sizeBase,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        BbCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'Paste the token from your invite link to join a team.',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: AppSpacing.s3),
              BbButton(
                label: 'Accept invite',
                variant: BbButtonVariant.secondary,
                block: true,
                onPressed: () => _openAccept(context),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _openInvite(BuildContext context) async {
    final OrgCubit cubit = context.read<OrgCubit>();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceCard,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
      ),
      builder: (_) => _InviteSheet(cubit: cubit),
    );
  }

  Future<void> _openAccept(BuildContext context) async {
    final OrgCubit cubit = context.read<OrgCubit>();
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.surfaceCard,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
      ),
      builder: (_) => _AcceptSheet(cubit: cubit),
    );
  }

  Future<void> _confirmRemove(BuildContext context, OrgMemberView member) async {
    final OrgCubit cubit = context.read<OrgCubit>();
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        backgroundColor: AppColors.surfaceCard,
        title: const Text('Remove teammate?'),
        content: Text('${member.emailMasked} will lose access to this team.'),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            style: TextButton.styleFrom(foregroundColor: AppColors.danger),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final OrgActionResult result = await cubit.remove(member.memberId);
    if (!context.mounted) return;
    _toast(context, result.success, result.message);
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          BbIconButton(
            icon: Icons.arrow_back,
            semanticLabel: 'Back',
            onPressed: onBack,
          ),
          const SizedBox(width: AppSpacing.s3),
          Text(
            'Team',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({
    required this.member,
    required this.canRemove,
    required this.showBorder,
    required this.onRemove,
  });

  final OrgMemberView member;
  final bool canRemove;
  final bool showBorder;
  final VoidCallback onRemove;

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
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        member.emailMasked,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.mono(
                          size: AppTypography.sizeSm,
                          weight: FontWeight.w600,
                        ),
                      ),
                    ),
                    if (member.isSelf) ...<Widget>[
                      const SizedBox(width: AppSpacing.s2),
                      const BbBadge('You', tone: BbBadgeTone.info),
                    ],
                  ],
                ),
                const SizedBox(height: 6),
                Row(
                  children: <Widget>[
                    BbBadge(
                      member.roleLabel,
                      tone: member.isOwner
                          ? BbBadgeTone.brand
                          : BbBadgeTone.neutral,
                    ),
                    const SizedBox(width: AppSpacing.s2),
                    BbBadge(
                      member.statusLabel,
                      tone: member.isActive
                          ? BbBadgeTone.success
                          : member.isInvited
                              ? BbBadgeTone.warning
                              : BbBadgeTone.neutral,
                    ),
                  ],
                ),
              ],
            ),
          ),
          if (canRemove)
            BbIconButton(
              icon: Icons.person_remove_alt_1_outlined,
              semanticLabel: 'Remove ${member.emailMasked}',
              onPressed: onRemove,
            ),
        ],
      ),
    );
  }
}

/// Invite sheet — the ONE place a raw email is accepted, handed straight to the
/// POST and never stored/logged. The list refetches to show the masked row.
class _InviteSheet extends StatefulWidget {
  const _InviteSheet({required this.cubit});

  final OrgCubit cubit;

  @override
  State<_InviteSheet> createState() => _InviteSheetState();
}

class _InviteSheetState extends State<_InviteSheet> {
  final TextEditingController _email = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final String email = _email.text.trim();
    if (email.isEmpty || !email.contains('@')) return;
    setState(() => _busy = true);
    final OrgActionResult result = await widget.cubit.invite(email);
    if (!mounted) return;
    Navigator.of(context).pop();
    _toast(context, result.success, result.message);
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
            'Invite recruiter',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            "They join as a recruiter. We'll email them a link to accept.",
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          BbField(
            label: 'Their email',
            controller: _email,
            hint: 'name@company.in',
            icon: Icons.mail_outline,
            keyboardType: TextInputType.emailAddress,
          ),
          const SizedBox(height: AppSpacing.s5),
          BbButton(
            label: 'Send invite',
            block: true,
            loading: _busy,
            onPressed: _busy ? null : _send,
          ),
        ],
      ),
    );
  }
}

/// Accept-invite sheet — pastes the single-use token from the invite link.
class _AcceptSheet extends StatefulWidget {
  const _AcceptSheet({required this.cubit});

  final OrgCubit cubit;

  @override
  State<_AcceptSheet> createState() => _AcceptSheetState();
}

class _AcceptSheetState extends State<_AcceptSheet> {
  final TextEditingController _token = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _token.dispose();
    super.dispose();
  }

  Future<void> _accept() async {
    final String token = _token.text.trim();
    if (token.length < 16) return;
    setState(() => _busy = true);
    final OrgActionResult result = await widget.cubit.acceptInvite(token);
    if (!mounted) return;
    Navigator.of(context).pop();
    _toast(context, result.success, result.message);
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
            'Accept invite',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          BbField(
            label: 'Invite token',
            controller: _token,
            hint: 'Paste from your invite link',
            mono: true,
          ),
          const SizedBox(height: AppSpacing.s5),
          BbButton(
            label: 'Join team',
            block: true,
            loading: _busy,
            onPressed: _busy ? null : _accept,
          ),
        ],
      ),
    );
  }
}

void _toast(BuildContext context, bool success, String message) {
  showBbToast(
    context,
    title: success ? 'Done' : 'Not now',
    message: message,
    icon: success ? Icons.check_circle : Icons.info_outline,
  );
}
