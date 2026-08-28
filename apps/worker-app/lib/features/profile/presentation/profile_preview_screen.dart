import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/education_label.dart';
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
          // Profile confirmed — the finishing form (#1296) collects the closed-set
          // work-history + preferences, THEN generates the resume (Building) and
          // enters the shell. context.go clears the onboarding stack (point of no
          // return); the finishing form carries on to Building on completion.
          context.go(Routes.finishing);
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
          // Kit 04 CONFIRM actions: [Badlo outline] + [Haan, sahi hai primary].
          // "Badlo" routes back to the chat to change details (the app's edit
          // path); "Haan, sahi hai" confirms + generates the resume.
          bottomBar: isReady
              ? Row(
                  children: <Widget>[
                    Expanded(
                      child: BbButton(
                        label: 'Badlo',
                        variant: BbButtonVariant.outline,
                        block: true,
                        onPressed: () => _backToChat(context),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.s3),
                    Expanded(
                      flex: 2,
                      child: BbButton(
                        label: 'Haan, sahi hai',
                        block: true,
                        // #360 — on 2G this request can run the full 15s timeout.
                        // An unbound button looked dead, so the worker tapped
                        // repeatedly at the last step of the flow and gave up.
                        loading: state.confirming,
                        onPressed: context.read<ProfileCubit>().confirm,
                      ),
                    ),
                  ],
                )
              : null,
          body: switch (state.status) {
            ProfileStatus.extracting => _buildWaiting(),
            ProfileStatus.failed => _buildFailed(context, state),
            ProfileStatus.draft => _buildDraft(context),
            ProfileStatus.ready ||
            ProfileStatus.confirmed =>
              _buildProfile(context, state.summary),
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

  /// Renders the REAL extracted profile read back from the summary route, as the
  /// kit 04 CONFIRM sheet content: a "Yeh sahi hai?" title over label→value rows,
  /// each editable row carrying an edit glyph (tap → back to chat to change it).
  /// Every value is actual data or an honest "being finalised" note — never a
  /// fabricated placeholder (the worker confirms what they can actually see).
  Widget _buildProfile(BuildContext context, ProfileSummary? summary) {
    final List<Widget> rows = <Widget>[];
    if (summary == null) {
      // Extraction succeeded but the summary read missed. Be honest — no fake
      // rows — and still let the worker confirm (the profile does exist).
      rows.add(const _ConfirmRow(label: 'Profile', value: 'Ready', last: true));
    } else {
      final String trade = (summary.tradeLabel?.isNotEmpty ?? false)
          ? summary.tradeLabel!
          : 'Tayyar ho raha hai…';
      final String? city =
          (summary.city?.isNotEmpty ?? false) ? summary.city : null;
      // PII-free education labels — shown only when present, never fabricated.
      final String? education = _educationLabel(summary);

      // The data facts the worker confirms (each editable via chat). The
      // "Profile strength" row was removed here (#844): a completeness score is
      // not an input to "is this correct?", and a low number reads like a failing
      // grade at the moment we want a simple yes. `strength*` stay on
      // ProfileSummary — other screens still use them; this screen just no longer
      // renders the row.
      final List<({String label, String value, bool editable})> specs =
          <({String label, String value, bool editable})>[
        (label: 'Trade', value: trade, editable: true),
        if (city != null) (label: 'City', value: city, editable: true),
        if (education != null)
          (label: 'Education', value: education, editable: true),
      ];
      for (int i = 0; i < specs.length; i++) {
        final ({String label, String value, bool editable}) s = specs[i];
        rows.add(_ConfirmRow(
          label: s.label,
          value: s.value,
          last: i == specs.length - 1,
          onEdit: s.editable ? () => _backToChat(context) : null,
        ));
      }
    }

    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        Text('Yeh sahi hai?',
            style: AppTypography.display(
                size: AppTypography.sizeLg, color: AppColors.blue)),
        const SizedBox(height: AppSpacing.s2),
        Text('Neeche di gayi jaankari confirm karein.',
            style: AppTypography.body(color: AppColors.textSecondary)),
        const SizedBox(height: AppSpacing.s4),
        Container(
          decoration: BoxDecoration(
            color: AppColors.surfaceCard,
            border: Border.all(color: AppColors.borderSubtle),
            borderRadius: BorderRadius.circular(AppRadii.sm),
          ),
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
          child: Column(children: rows),
        ),
        if (summary == null) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          Text(
            'Details abhi dikh nahi paa rahe — aap confirm karke aage badh sakte hain.',
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
        ],
      ],
    );
  }
}

/// "12th • Electronics" / "12th" / "Electronics"; `null` when both are absent so
/// the preview row is omitted entirely. PII-free labels, never fabricated.
String? _educationLabel(ProfileSummary s) {
  final List<String> parts = <String>[
    if (s.educationLevel?.isNotEmpty ?? false)
      humanizeEducationLevel(s.educationLevel!),
    if (s.educationField?.isNotEmpty ?? false) s.educationField!,
  ];
  return parts.isEmpty ? null : parts.join(' • ');
}

/// One kit 04 CONFIRM sheet row: `label` on the left, `value` on the right with
/// an optional edit glyph. A bottom hairline separates rows (the design system's
/// only separation tool) except on the [last] row. When [onEdit] is set the whole
/// row is the tap target (≥48px), routing back to the chat to change the fact.
class _ConfirmRow extends StatelessWidget {
  const _ConfirmRow({
    required this.label,
    required this.value,
    this.onEdit,
    this.last = false,
  });

  final String label;
  final String value;
  final VoidCallback? onEdit;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final Widget row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: AppSpacing.tap),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
        decoration: last
            ? null
            : const BoxDecoration(
                border: Border(
                    bottom: BorderSide(color: AppColors.divider)),
              ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: <Widget>[
            Text(label,
                style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textSecondary)),
            const SizedBox(width: AppSpacing.s3),
            Flexible(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.end,
                children: <Widget>[
                  Flexible(
                    child: Text(value,
                        textAlign: TextAlign.end,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.body(
                            size: AppTypography.sizeMd,
                            weight: FontWeight.w600)),
                  ),
                  if (onEdit != null) ...<Widget>[
                    const SizedBox(width: AppSpacing.s2),
                    const Icon(Icons.edit, size: 16, color: AppColors.blue),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );

    if (onEdit == null) return row;
    return InkWell(onTap: onEdit, child: row);
  }
}

