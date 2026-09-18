import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/app_config.dart';
import '../../../core/config/remote_config.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/education_label.dart';
import '../../../core/util/push_once.dart';
import '../../../core/util/taxonomy_labels.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_alerts_action.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_header_actions.dart';
import '../../../core/widgets/kit/kit_info_chip.dart';
import '../../../core/widgets/kit/kit_micro_label.dart';
import '../../../core/widgets/kit/kit_tab_header.dart';
import '../../../router.dart';
import '../domain/profile_summary.dart';
import 'cubit/profile_tab_cubit.dart';
import 'widgets/profile_identity_card.dart';
import 'widgets/profile_strength_card.dart';

/// #1524 — the chat-road badge on the Profile tab. A chat-sourced profile is
/// labelled so it is never mistaken for the form road's trade-sheet profile.
const String kChatProfileSourceLabel = 'Chat se bani profile';

/// The tabbed Profile (UI kit v3) — distinct from the profiling ProfilePreview.
///
/// Navy tab header (spec §4) + the worker's identity card + the strength nudge
/// + their skills and machines as kit chips + the Profile shortcuts (the kit
/// routes are nested under this Profile branch — WA-3).
///
/// The identity block used to be painted into the blue header; v3 moves it into
/// the first CARD of the list, so the header is the artboard's 48dp row and the
/// name/facts can wrap at any system font size.
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
        backgroundColor: OnboardingColors.canvasBg,
        body: Column(
          children: <Widget>[
            _header(context),
            Expanded(
              child: BlocBuilder<ProfileTabCubit, ProfileTabState>(
                builder: (BuildContext context, ProfileTabState state) =>
                    _body(context, state),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The navy tab header (spec §4). It carries the tab's three actions: the
  /// alerts bell (notifications lost their nav tab in the 4-tab set), Settings,
  /// and Feedback — the yellow chat glyph, which means FEEDBACK in v3 (R2). The
  /// old `BbChatAction` is gone: the Bada Bhai tab is the way into the chat, and
  /// the same glyph meaning two things across tabs was the confusion R2 settled.
  ///
  /// Built OUTSIDE the BlocBuilder: the chrome no longer depends on the loaded
  /// summary, so it does not rebuild when the profile does.
  Widget _header(BuildContext context) {
    return KitTabHeader(
      title: 'Profile',
      actions: <Widget>[
        // Keeps the BbAlertsAction TYPE (its unread badge and the e2e finder
        // both hang off it); only the glyph colour changes for the navy band.
        const BbAlertsAction(color: OnboardingColors.textOnBlue),
        KitHeaderIconAction(
          icon: Icons.settings_outlined,
          tooltip: 'Settings',
          onPressed: () => context.pushOnce(Routes.settings),
        ),
        const KitFeedbackAction(),
      ],
    );
  }

  /// The state-driven content below the header.
  Widget _body(BuildContext context, ProfileTabState state) {
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
      ProfileTabStatus.ready => _profile(context, state),
    };
  }

  Widget _profile(BuildContext context, ProfileTabState state) {
    final ProfileSummary s = state.summary!;
    // Padding, not a wrapper: the scroll bar and the overscroll glow stay at
    // the screen edge while the content column centres on a tablet (D7/R13).
    final EdgeInsets side = KitInsets.list(
      MediaQuery.sizeOf(context).width,
      max: OnboardingLayout.maxTabContentWidth,
      gutter: 14,
    );
    // #1322: at most ONE humanized nudge, derived from the server's strength
    // band + ordered `missing_fields`. Collapses to nothing at Strong (and when
    // nothing is missing) — never a grade, never an "N/9" score. Asked here so
    // the gap around it collapses too.
    final bool showNudge = profileStrengthNudgeVisible(
      signals: s.strengthSignals,
      max: s.strengthMax,
      missingFields: s.missingFields,
    );

    return ListView(
      padding: EdgeInsets.fromLTRB(side.left, 14, side.right, 24),
      children: <Widget>[
        ProfileIdentityCard(summary: s, displayName: state.displayName),
        // #1524 — a chat-sourced profile carries a visible chat-road badge so
        // the tab never silently renders chat data as a form profile. Unknown
        // (`null`) and form sources keep today's exact layout.
        if (s.isChatSourced) ...<Widget>[
          const SizedBox(height: 12),
          const Align(
            alignment: Alignment.centerLeft,
            child: KitInfoChip(
              label: kChatProfileSourceLabel,
              dot: OnboardingColors.shiftBlue,
            ),
          ),
        ],
        if (showNudge) ...<Widget>[
          const SizedBox(height: 12),
          ProfileStrengthCard(
            signals: s.strengthSignals,
            max: s.strengthMax,
            missingFields: s.missingFields,
          ),
        ],
        const SizedBox(height: 12),
        _skillsCard(s),
        const SizedBox(height: 12),
        _shortcutsCard(context),
        // Comfortable separation from the content above; logout sits last.
        const SizedBox(height: 32),
        _logoutButton(context),
        // TEST-ONLY (kEnableTestDelete): compiled out of a normal release, so a
        // stock build never carries it. Sits just below logout for QA.
        if (kEnableTestDelete) ...<Widget>[
          const SizedBox(height: 12),
          _deleteAccountButton(context),
        ],
      ],
    );
  }

  /// Logout as the v3 full-width outlined danger button (spec §4's last-action
  /// shape, in `errorRed`): quieter than the filled crimson slab, because
  /// signing out is reversible — unlike the test-delete below it, which stays
  /// filled.
  Widget _logoutButton(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: () => _confirmLogout(context),
      icon: const Icon(Icons.logout_rounded, size: 20),
      label: const Text('Logout'),
      style: OutlinedButton.styleFrom(
        backgroundColor: OnboardingColors.paperWhite,
        foregroundColor: OnboardingColors.errorRed,
        elevation: 0,
        shadowColor: Colors.transparent,
        side: const BorderSide(color: OnboardingColors.errorRed, width: 1.2),
        minimumSize: const Size(
          double.infinity,
          OnboardingLayout.dockedButtonHeight,
        ),
        tapTargetSize: MaterialTapTargetSize.padded,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(
            Radius.circular(OnboardingRadii.docked),
          ),
        ),
        textStyle: OnboardingTypography.anek(
          size: 14,
          weight: FontWeight.w800,
          letterSpacing: 0.3,
        ),
      ),
    );
  }

  Future<void> _confirmLogout(BuildContext context) async {
    final ProfileTabCubit cubit = context.read<ProfileTabCubit>();
    final bool confirmed = await showBbConfirm(
      context,
      title: 'Logout karein?',
      message: 'Aap dobara login kar sakte hain.',
      confirmLabel: 'Logout',
      cancelLabel: 'Cancel',
      destructive: true,
    );
    if (!confirmed) return;

    // Best-effort server revoke + local session wipe (offline-safe), then exit
    // the StatefulShell back to the linear login flow.
    await cubit.logout();
    if (!context.mounted) return;
    context.go(Routes.phoneLogin);
  }

  /// TEST-ONLY affordance (rendered only when [kEnableTestDelete]): a danger
  /// button that triggers the immediate account-delete flow so QA can reach it
  /// without a DBA.
  Widget _deleteAccountButton(BuildContext context) {
    return BbButton(
      label: 'Delete account (test)',
      block: true,
      size: BbButtonSize.md,
      variant: BbButtonVariant.danger,
      iconLeft: Icons.delete_forever_rounded,
      onPressed: () => _confirmDeleteAccount(context),
    );
  }

  Future<void> _confirmDeleteAccount(BuildContext context) async {
    final ProfileTabCubit cubit = context.read<ProfileTabCubit>();
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final bool confirmed = await showBbConfirm(
      context,
      title: 'Account delete karein?',
      message: 'Yeh aapka account turant delete kar dega.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    );
    if (!confirmed) return;

    // On success the account is gone and the session is wiped — leave the shell
    // for the login flow. On failure (incl. a 404 = endpoint disabled on this
    // server, which the bool can't distinguish) surface an honest, general line.
    final bool deleted = await cubit.deleteAccountForTest();
    if (!context.mounted) return;
    if (deleted) {
      context.go(Routes.phoneLogin);
    } else {
      messenger.showSnackBar(
        const SnackBar(
          content: Text('Test delete is not enabled on this server.'),
        ),
      );
    }
  }

  /// Skills, machines and years of experience as a STRUCTURED section — the data
  /// the LLM extracts after registration, surfaced here instead of only being
  /// baked into the resume text (the user's ask). Every field is PII-free: the
  /// canonical skill/machine labels and a years NUMBER — never the free-text
  /// experience summary (which the backend deliberately keeps off the wire, §2).
  /// Renders an honest empty state until the worker has shared any.
  ///
  /// The count pill carries the real total and nothing else (ruling R8): the
  /// chips have NO green check, because a tick claims someone verified the value
  /// and no per-item verification exists on the wire (R9, B8).
  Widget _skillsCard(ProfileSummary s) {
    final String? education = _educationLabel(s);
    final bool hasAny =
        s.skills.isNotEmpty ||
        s.machines.isNotEmpty ||
        s.experienceYears != null ||
        education != null;
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          KitCardHeader(
            icon: Icons.construction_rounded,
            title: 'Skills aur anubhav',
            count: s.skills.length + s.machines.length,
          ),
          const SizedBox(height: 12),
          if (!hasAny)
            Text(
              'Abhi kuch nahi — chat mein apne skills aur experience batayein.',
              style: OnboardingTypography.bodyMuted(),
            )
          else
            ..._structuredRows(s, education),
        ],
      ),
    );
  }

  /// The experience / education / skills / machines groups, separated by a
  /// consistent gap. Any absent group is dropped (never a fabricated
  /// placeholder).
  List<Widget> _structuredRows(ProfileSummary s, String? education) {
    final double? years = s.experienceYears;
    final List<Widget> groups = <Widget>[
      if (years != null)
        _infoRow(
          Icons.work_outline_rounded,
          'Anubhav: ${profileExperienceLabel(years)}',
        ),
      if (education != null)
        _infoRow(Icons.school_outlined, 'Padhai: $education'),
      if (s.skills.isNotEmpty)
        _chipGroup('Skills', s.skills, OnboardingColors.successGreen),
      if (s.machines.isNotEmpty)
        _chipGroup('Machines', s.machines, OnboardingColors.shiftBlue),
    ];
    return <Widget>[
      for (int i = 0; i < groups.length; i++) ...<Widget>[
        if (i > 0) const SizedBox(height: 12),
        groups[i],
      ],
    ];
  }

  /// A single fact as the kit's full-width row (spec §4) — an icon, then the
  /// line. No green check: experience and schooling are self-declared, so a
  /// tick would claim a verification nobody performed.
  Widget _infoRow(IconData icon, String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: OnboardingColors.rowBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 18, color: OnboardingColors.ink500),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: OnboardingTypography.inter(
                size: 13,
                weight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// A micro-labelled wrap of kit chips (spec §4). Ruling R9 reverses the old
  /// "no chips" call — with one carve-out: no check glyph (see [_skillsCard]).
  /// Labels go through [replaceTaxonomyIds], so a raw `skill_*` / `mach_*` id
  /// can never reach a worker's screen.
  Widget _chipGroup(String label, List<String> items, Color dot) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        KitMicroLabel(label),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: <Widget>[
            for (final String item in items)
              KitInfoChip(label: replaceTaxonomyIds(item), dot: dot),
          ],
        ),
      ],
    );
  }

  /// "12th • Electronics" / "12th" / "Electronics"; `null` when both are absent
  /// so the row is omitted entirely. PII-free labels, never fabricated.
  String? _educationLabel(ProfileSummary s) {
    final List<String> parts = <String>[
      if (s.educationLevel?.isNotEmpty ?? false)
        humanizeEducationLevel(s.educationLevel!),
      if (s.educationField?.isNotEmpty ?? false) s.educationField!,
    ];
    return parts.isEmpty ? null : parts.join(' • ');
  }

  /// The Profile shortcuts grouped into one white card, split by hairlines
  /// (kit grouped-list idiom). Navigation targets are unchanged:
  ///  - Interview kit opens WITHIN the Profile branch (WA-3: nested under
  ///    /profile, so backing out of the kit lands on Profile, not Resume).
  ///  - Applied jobs is pushed full-screen from Profile (back → Profile).
  ///  - Invite (route already present) is gated by the same B7 kill switch the
  ///    Settings screen uses, so hiding the funnel hides it here too.
  Widget _shortcutsCard(BuildContext context) {
    final bool showInvite = !BbRemoteConfig.instance.inviteEntryHidden;
    return KitCard(
      padding: EdgeInsets.zero,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        child: Column(
          children: <Widget>[
            BbListRow.kit(
              icon: Icons.edit_note_outlined,
              title: 'Profile edit karein',
              subtitle: 'WhatsApp, bhasha, training, portfolio',
              onTap: () => context.pushOnce(Routes.profileEdit),
            ),
            _hairline,
            BbListRow.kit(
              icon: Icons.quiz_outlined,
              title: 'Interview kit',
              subtitle: '15 sawaal + jawaab',
              onTap: () => context.pushOnce(Routes.kit),
            ),
            _hairline,
            BbListRow.kit(
              icon: Icons.work_history,
              title: 'Applied jobs',
              subtitle: 'Aapki apply ki gayi jobs',
              onTap: () => context.pushOnce(Routes.appliedJobs),
            ),
            if (showInvite) ...<Widget>[
              _hairline,
              BbListRow.kit(
                icon: Icons.person_add_alt_1_outlined,
                title: 'Dost ko invite karein',
                subtitle: 'Referral link share karein',
                onTap: () => context.pushOnce(Routes.invite),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget get _hairline => const Divider(
    height: 1,
    thickness: 1,
    indent: 16,
    endIndent: 16,
    color: OnboardingColors.borderSubtle,
  );
}
