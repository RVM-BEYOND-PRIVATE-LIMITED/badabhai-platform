import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chat_action.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_progress_bar.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_verified_badge.dart';
import '../../../router.dart';
import '../../../core/util/taxonomy_labels.dart';
import 'cubit/profile_tab_cubit.dart';
import 'widgets/profile_avatar.dart';
import '../domain/profile_summary.dart';

/// The tabbed Profile (spec §5.9) — distinct from the profiling ProfilePreview.
/// Header + strength card + the Interview-kit shortcut (the kit routes are
/// nested under this Profile branch — WA-3).
class ProfileTabScreen extends StatelessWidget {
  const ProfileTabScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ProfileTabCubit>(
      create: (_) => locator<ProfileTabCubit>()..load(),
      child: const _ProfileTabView(),
    );
  }
}

class _ProfileTabView extends StatelessWidget {
  const _ProfileTabView();

  @override
  Widget build(BuildContext context) {
    // The IndexedStack keeps this branch mounted, so create: runs only on the
    // first visit — refetch when the tab comes back into view (T4).
    return TabFocusRefetch(
      tabFocus: locator<TabFocus>(),
      index: TabIndex.profile,
      onFocused: () => context.read<ProfileTabCubit>().refresh(),
      child: Scaffold(
        appBar: BbAppBar(
          title: 'Profile',
          actions: <Widget>[
            const BbChatAction(),
            IconButton(
              tooltip: 'Settings',
              icon: const Icon(Icons.settings_outlined),
              onPressed: () => context.push(Routes.settings),
            ),
          ],
        ),
        body: BlocBuilder<ProfileTabCubit, ProfileTabState>(
          builder: (BuildContext context, ProfileTabState state) {
            return switch (state.status) {
              ProfileTabStatus.loading => const BbStatusView.loading(),
              ProfileTabStatus.failed => BbStatusView(
                  icon: failureReason(state.failure).icon,
                  title: 'Profile load nahi hui.',
                  subtitle: failureReason(state.failure).reason,
                  action: FilledButton(
                    onPressed: () => context.read<ProfileTabCubit>().load(),
                    child: const Text('Try again'),
                  ),
                ),
              ProfileTabStatus.ready => _profile(context, state.summary!),
            };
          },
        ),
      ),
    );
  }

  Widget _profile(BuildContext context, ProfileSummary s) {
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      children: <Widget>[
        _header(s),
        const SizedBox(height: AppSpacing.s5),
        _strengthCard(s),
        const SizedBox(height: AppSpacing.s4),
        _skillsCard(s),
        const SizedBox(height: AppSpacing.s4),
        _kitShortcut(context),
        const SizedBox(height: AppSpacing.s4),
        _appliedShortcut(context),
        // Comfortable separation from the content above; logout sits last.
        const SizedBox(height: AppSpacing.s8),
        _logoutButton(context),
      ],
    );
  }

  Widget _logoutButton(BuildContext context) {
    return BbButton(
      label: 'Logout',
      block: true,
      variant: BbButtonVariant.danger,
      iconLeft: Icons.logout_rounded,
      onPressed: () => _confirmLogout(context),
    );
  }

  Future<void> _confirmLogout(BuildContext context) async {
    final ProfileTabCubit cubit = context.read<ProfileTabCubit>();
    final bool confirmed = await showDialog<bool>(
          context: context,
          builder: (BuildContext dialogContext) => AlertDialog(
            title: const Text('Logout karein?'),
            content: const Text('Aap dobara login kar sakte hain.'),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                child: const Text('Cancel'),
              ),
              TextButton(
                style: TextButton.styleFrom(foregroundColor: AppColors.red600),
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: const Text('Logout'),
              ),
            ],
          ),
        ) ??
        false;
    if (!confirmed) return;

    // Best-effort server revoke + local session wipe (offline-safe), then exit
    // the StatefulShell back to the linear login flow.
    await cubit.logout();
    if (!context.mounted) return;
    context.go(Routes.phoneLogin);
  }

  Widget _header(ProfileSummary s) {
    final String resolvedTrade = replaceTaxonomyIds(s.tradeLabel ?? '');
    // The worker's NAME is an open §2 escalation and is NOT on the wire today —
    // lead with the trade label (then a neutral generic) rather than fabricate a
    // name. Only repeat the trade in the subline when a name IS the headline.
    final String headline = s.displayName ?? (resolvedTrade.isNotEmpty ? resolvedTrade : 'Aapki profile');
    final List<String> subParts = <String>[
      if (s.displayName != null && resolvedTrade.isNotEmpty)
        resolvedTrade,
      if (s.city?.isNotEmpty ?? false) s.city!,
    ];
    final String? subline = subParts.isEmpty ? null : subParts.join(' · ');

    return Row(
      children: <Widget>[
        // ADR-0032 — the worker's real photo, with the edit entry point. The tab
        // used to render initials/an icon only, and the comment below admitted
        // the photo flow was reachable ONLY from the resume-edit screen. Same
        // photo, same endpoints, same shared sheet — no second concept.
        ProfileAvatar(
          initials: s.initials,
          verified: s.verified,
          verifiedBadge: const BbSeal(),
        ),
        const SizedBox(width: AppSpacing.s4),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(headline,
                  style: AppTypography.display(
                      size: AppTypography.sizeXl, weight: FontWeight.w800)),
              if (subline != null) ...<Widget>[
                const SizedBox(height: 2),
                Text(subline,
                    style: AppTypography.body(color: AppColors.textMuted)),
              ],
              if (s.verified) ...<Widget>[
                const SizedBox(height: AppSpacing.s2),
                const BbVerifiedBadge(),
              ],
            ],
          ),
        ),
      ],
    );
  }

  /// WA-4: the backend `strength` is an integer SIGNAL COUNT (countFields,
  /// recomputed on read) with NO denominator on the wire — this card used to
  /// render `count * 100 %` (e.g. "800%") over a bar fed the raw count, plus a
  /// "photo → 100%" line no backend field backs. It now shows the honest count
  /// in DS voice ("N cheezein" — never dev vocabulary like "signals", L-2);
  /// the moment the API ships `strength_max` the real N/max meter + bar light
  /// up via [ProfileSummary.strengthMax] — nothing here divides by a
  /// client-side magic number. ("Add X" hints need the missing field LIST,
  /// which the summary response does not carry either.)
  Widget _strengthCard(ProfileSummary s) {
    final int n = s.strengthSignals;
    final int? max = s.strengthMax;
    final bool hasMax = max != null && max > 0;
    final String meter = hasMax ? '$n/$max' : '$n cheezein';
    final String hint = n == 0
        ? 'Abhi profile khaali hai — chat mein apne skills aur experience batayein.'
        : 'Profile mein $n cheezein complete — chat mein aur jankari denge to aur strong hogi.';
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              Text('Profile strength',
                  style: AppTypography.body(
                      size: AppTypography.sizeSm, weight: FontWeight.w700)),
              Text(meter,
                  style: AppTypography.mono(color: AppColors.textMuted)),
            ],
          ),
          // A fraction bar exists ONLY when a real denominator exists.
          if (hasMax) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            BbProgressBar(value: n / max),
          ],
          const SizedBox(height: AppSpacing.s3),
          // ADR-0032 nudge route-through intentionally NOT taken here: #340 was cut
          // before #326, and its copy hardcoded "…aur 100% tak pahunchein" — the
          // fabricated percent WA-4 removed (no backend field backs it). This hint
          // also points to CHAT, so a tap to resumeEdit would contradict its text.
          // The photo flow stays reachable via the edit screen's "Aapki photo" row.
          Text(hint, style: AppTypography.body(color: AppColors.textMuted)),
        ],
      ),
    );
  }

  /// Skills, machines and years of experience as a STRUCTURED section — the data
  /// the LLM extracts after registration, surfaced here instead of only being
  /// baked into the resume text (the user's ask). Every field is PII-free: the
  /// canonical skill/machine labels and a years NUMBER — never the free-text
  /// experience summary (which the backend deliberately keeps off the wire, §2).
  /// Renders an honest empty state until the worker has shared any.
  Widget _skillsCard(ProfileSummary s) {
    final String? education = _educationLabel(s);
    final bool hasAny = s.skills.isNotEmpty ||
        s.machines.isNotEmpty ||
        s.experienceYears != null ||
        education != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text('Skills aur anubhav',
            style: AppTypography.body(
                size: AppTypography.sizeSm, weight: FontWeight.w700)),
        const SizedBox(height: AppSpacing.s3),
        if (!hasAny)
          Text(
            'Abhi kuch nahi — chat mein apne skills aur experience batayein.',
            style: AppTypography.body(color: AppColors.textMuted),
          )
        else
          ..._structuredRows(s, education),
      ],
    );
  }

  /// The experience / education / skills / machines rows, separated by a
  /// consistent gap. Any absent row is dropped (never a fabricated placeholder).
  List<Widget> _structuredRows(ProfileSummary s, String? education) {
    final List<Widget> rows = <Widget>[
      if (s.experienceYears != null)
        _infoLine(Icons.work_outline_rounded,
            'Anubhav: ${_experienceLabel(s.experienceYears!)}'),
      if (education != null)
        _infoLine(Icons.school_outlined, 'Padhai: $education'),
      if (s.skills.isNotEmpty) _textGroup('Skills', s.skills),
      if (s.machines.isNotEmpty) _textGroup('Machines', s.machines),
    ];
    return <Widget>[
      for (int i = 0; i < rows.length; i++) ...<Widget>[
        if (i > 0) const SizedBox(height: AppSpacing.s3),
        rows[i],
      ],
    ];
  }

  /// An icon + bold label line (experience / education). Text is [Expanded] so a
  /// longer education label wraps instead of overflowing.
  Widget _infoLine(IconData icon, String text) {
    return Row(
      children: <Widget>[
        Icon(icon, size: 18, color: AppColors.textMuted),
        const SizedBox(width: AppSpacing.s2),
        Expanded(
          child: Text(text,
              style: AppTypography.body(
                  size: AppTypography.sizeSm, weight: FontWeight.w600)),
        ),
      ],
    );
  }

  /// "12th • Electronics" / "12th" / "Electronics"; `null` when both are absent
  /// so the row is omitted entirely. PII-free labels, never fabricated.
  String? _educationLabel(ProfileSummary s) {
    final List<String> parts = <String>[
      if (s.educationLevel?.isNotEmpty ?? false) s.educationLevel!,
      if (s.educationField?.isNotEmpty ?? false) s.educationField!,
    ];
    return parts.isEmpty ? null : parts.join(' • ');
  }

  /// A labelled wrap of plain text (skills or machines). Label is bold, values
  /// are normal weight, comma-separated — no chips, no borders.
  Widget _textGroup(String label, List<String> items) {
    // Text.rich (not a raw RichText): a `Text` widget is what `find.text*`
    // matches on its `textSpan.toPlainText()`, keeping the section testable.
    return Text.rich(
      TextSpan(
        style: AppTypography.body(
            size: AppTypography.sizeSm, color: AppColors.textPrimary),
        children: <TextSpan>[
          TextSpan(
            text: '$label: ',
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          TextSpan(
            text: items.map(replaceTaxonomyIds).join(', '),
          ),
        ],
      ),
    );
  }

  /// "4 saal" / "2.5 saal" — drop a trailing ".0" so whole years read cleanly.
  String _experienceLabel(double years) {
    final bool whole = years == years.roundToDouble();
    final String n = whole ? years.toStringAsFixed(0) : years.toStringAsFixed(1);
    return '$n saal';
  }

  Widget _kitShortcut(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      // Opens the kit WITHIN the Profile branch (WA-3): the kit routes are
      // nested under /profile, so the Profile tab stays active and backing out
      // of the kit lands here — not on the Resume tab.
      child: BbListRow.kit(
        icon: Icons.quiz_outlined,
        title: 'Interview kit',
        subtitle: '15 sawaal + jawaab',
        onTap: () => context.push(Routes.kit),
      ),
    );
  }

  Widget _appliedShortcut(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      // Pushed full-screen from Profile (back → Profile), like Settings.
      child: BbListRow.kit(
        icon: Icons.work_history,
        title: 'Applied jobs',
        subtitle: 'Aapki apply ki gayi jobs',
        onTap: () => context.push(Routes.appliedJobs),
      ),
    );
  }
}
