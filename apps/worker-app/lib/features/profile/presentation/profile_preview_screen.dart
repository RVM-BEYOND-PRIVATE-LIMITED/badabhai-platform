import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import '../../profile_tab/domain/profile_summary.dart';
import 'cubit/profile_cubit.dart';

class ProfilePreviewScreen extends StatelessWidget {
  const ProfilePreviewScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ProfileCubit>(
      create: (_) => locator<ProfileCubit>()..extract(),
      child: const _ProfileView(),
    );
  }
}

class _ProfileView extends StatelessWidget {
  const _ProfileView();

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ProfileCubit, ProfileState>(
      // #360: a failed confirm keeps status == ready, so a status-only
      // listenWhen would never announce it. Watch confirmFailure too.
      listenWhen: (prev, curr) =>
          prev.status != curr.status ||
          prev.confirmFailure != curr.confirmFailure,
      listener: (BuildContext context, ProfileState state) {
        if (state.status == ProfileStatus.confirmed) {
          // Profile confirmed — generate the resume (Building) then enter the
          // shell. context.go clears the onboarding stack (point of no return).
          context.go(Routes.building);
          return;
        }
        final Failure? failed = state.confirmFailure;
        if (failed != null) {
          // Say the REAL reason (never a generic "check internet"), and leave
          // the worker on the ready view where retry is one tap.
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(
              SnackBar(content: Text(failureReason(failed).reason)),
            );
        }
      },
      builder: (BuildContext context, ProfileState state) {
        final bool isReady = state.status == ProfileStatus.ready ||
            state.status == ProfileStatus.confirmed;
        return BbScaffold(
          appBar: const BbAppBar(title: 'Your profile'),
          bottomBar: isReady
              ? BbButton(
                  label: 'Confirm & generate resume',
                  block: true,
                  iconLeft: Icons.description_outlined,
                  // #360 — on 2G this request can run the full 15s timeout. An
                  // unbound button looked dead, so the worker tapped repeatedly
                  // at the last step of the flow and gave up.
                  loading: state.confirming,
                  onPressed: context.read<ProfileCubit>().confirm,
                )
              : null,
          body: switch (state.status) {
            ProfileStatus.extracting => _buildWaiting(),
            ProfileStatus.failed => _buildFailed(context, state),
            ProfileStatus.draft => _buildDraft(context),
            ProfileStatus.ready ||
            ProfileStatus.confirmed =>
              _buildProfile(state.summary),
          },
        );
      },
    );
  }

  Widget _buildWaiting() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const CircularProgressIndicator(),
          const SizedBox(height: AppSpacing.s6),
          Text(
            'Bada Bhai is preparing your profile…',
            textAlign: TextAlign.center,
            style: AppTypography.display(size: AppTypography.sizeMd),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'This takes a few seconds. Please wait.',
            textAlign: TextAlign.center,
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }

  Widget _buildFailed(BuildContext context, ProfileState state) {
    return BbStatusView(
      icon: failureReason(state.failure).icon,
      title: 'Profile taiyaar nahi ho payi.',
      subtitle: failureReason(state.failure).reason,
      // TWO ways out, never a dead-end loop. "Try again" re-runs extraction —
      // right for a transient network/server blip. But some failures are
      // DETERMINISTIC on the same transcript (a content-poor interview, an
      // AI-down job that never yields a profile), and re-running would loop
      // forever with no progress. So the worker always has the honest escape:
      // back to chat to add more detail (which #502 redraws intact).
      action: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          BbButton(
            label: 'Try again',
            block: true,
            iconLeft: Icons.refresh_rounded,
            onPressed: context.read<ProfileCubit>().extract,
          ),
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: 'Chat pe wapas jaayein',
            block: true,
            variant: BbButtonVariant.ghost,
            iconLeft: Icons.chat_bubble_outline,
            onPressed: () => _backToChat(context),
          ),
        ],
      ),
    );
  }

  /// The extraction produced too little to be a usable profile (backend
  /// `profile_status == 'draft'`, TD81/#503). Do NOT show the Confirm CTA — a
  /// draft confirmed becomes a near-empty resume. Be honest about why, and route
  /// the worker back to chat to say more (their transcript is redrawn by #502).
  Widget _buildDraft(BuildContext context) {
    return BbStatusView(
      icon: Icons.edit_note_outlined,
      title: 'Thodi aur detail chahiye.',
      subtitle: 'Bada Bhai aapki poori profile banane ke liye thoda aur jaanna '
          'chahta hai. Chaliye do-teen baatein aur bata dijiye.',
      action: BbButton(
        label: 'Chat pe wapas jaayein',
        block: true,
        iconLeft: Icons.chat_bubble_outline,
        onPressed: () => _backToChat(context),
      ),
    );
  }

  /// Returns the worker to the profiling chat. Prefer a pop (keeps the live chat
  /// bloc + its in-memory transcript, no flicker); fall back to a route change
  /// when this screen was not reached by a push (chat then re-mounts and #502
  /// redraws the transcript from the server).
  void _backToChat(BuildContext context) {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go(Routes.chatProfiling);
    }
  }

  /// Renders the REAL extracted profile read back from the summary route. Every
  /// value is actual data or an honest "being finalised" note — never a
  /// fabricated placeholder (the worker confirms what they can actually see).
  Widget _buildProfile(ProfileSummary? summary) {
    if (summary == null) {
      // Extraction succeeded but the summary read missed. Be honest — no fake
      // rows — and still let the worker confirm (the profile does exist).
      return ListView(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
        children: <Widget>[
          const _ProfileRow(
              icon: Icons.check_circle_outline,
              label: 'Profile',
              value: 'Ready'),
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Details abhi dikh nahi paa rahe — aap confirm karke aage badh sakte hain.',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
        ],
      );
    }

    final String trade = (summary.tradeLabel?.isNotEmpty ?? false)
        ? summary.tradeLabel!
        : 'Tayyar ho raha hai…';
    // WA-4: `strengthSignals` is the backend's integer signal count — shown as
    // an honest count in DS voice ("N cheezein complete"; "N/max" only once
    // the API ships a real denominator), never a client-fabricated percent.
    final int? strengthMax = summary.strengthMax;
    final String strengthValue = (strengthMax != null && strengthMax > 0)
        ? '${summary.strengthSignals}/$strengthMax cheezein complete'
        : '${summary.strengthSignals} cheezein complete';
    final String? city =
        (summary.city?.isNotEmpty ?? false) ? summary.city : null;
    // PII-free education labels — shown only when present, never fabricated.
    final String? education = _educationLabel(summary);

    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        Text('Aapki profile:',
            style: AppTypography.body(color: AppColors.textSecondary)),
        const SizedBox(height: AppSpacing.s4),
        _ProfileRow(
            icon: Icons.badge_outlined, label: 'Trade', value: trade),
        if (city != null) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          _ProfileRow(
              icon: Icons.place_outlined, label: 'City', value: city),
        ],
        if (education != null) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          _ProfileRow(
              icon: Icons.school_outlined,
              label: 'Education',
              value: education),
        ],
        const SizedBox(height: AppSpacing.s3),
        _ProfileRow(
            icon: Icons.insights_outlined,
            label: 'Profile strength',
            value: strengthValue),
      ],
    );
  }
}

/// "12th • Electronics" / "12th" / "Electronics"; `null` when both are absent so
/// the preview row is omitted entirely. PII-free labels, never fabricated.
String? _educationLabel(ProfileSummary s) {
  final List<String> parts = <String>[
    if (s.educationLevel?.isNotEmpty ?? false) s.educationLevel!,
    if (s.educationField?.isNotEmpty ?? false) s.educationField!,
  ];
  return parts.isEmpty ? null : parts.join(' • ');
}

/// One labelled profile attribute card with a warm saffron icon chip.
class _ProfileRow extends StatelessWidget {
  const _ProfileRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.s4),
        child: Row(
          children: <Widget>[
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: AppColors.saffron50,
                borderRadius: BorderRadius.circular(AppRadii.sm),
              ),
              child: Icon(icon, color: AppColors.saffronDeep, size: 24),
            ),
            const SizedBox(width: AppSpacing.s4),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(label, style: AppTypography.eyebrow()),
                const SizedBox(height: 2),
                Text(value,
                    style: AppTypography.body(
                        size: AppTypography.sizeMd, weight: FontWeight.w600)),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

