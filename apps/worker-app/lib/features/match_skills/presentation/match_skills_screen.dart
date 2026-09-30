import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/feedback_fab.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_docked_bar.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../domain/match_skill.dart';
import 'cubit/match_skills_cubit.dart';

/// Copy from #1831 (persona v3.2 draft — owner review before ship), except
/// [hint], which is #1828's "honest sentence". This exit ends FINDABILITY
/// only, and not even all of it per skill: a payer who already unlocked the
/// worker keeps his window, and a skill switched off can still bring its
/// postings through a RELATED skill left on (reach = posted ∪ related). So
/// nothing here may promise that employers stop seeing or contacting him.
abstract final class MatchSkillsCopy {
  static const String header = 'Mera kaam';
  static const String title = 'Aap kaun sa kaam karna chahte hain';
  static const String hint =
      'Jo kaam aap band karenge, woh naye employers ko nahi dikhega.';
  static const String clearAll = 'Sab kaam band karein';
  static const String clearAllConfirmTitle = 'Sab kaam band karein?';
  static const String clearAllConfirm =
      'Sab kaam band ho jayenge. Aap kabhi bhi wapas chalu kar sakte hain.';
  static const String empty = 'Abhi aapke kaam ki list khaali hai.';
  static const String loadFailed = 'Kaam ki list load nahi hui.';
  static const String saveFailed = 'Save nahi hua. Dobara try karein.';

  /// After clear-all: the switches it turned off (singular "gaya" for one).
  static String turnedOff(int n) => switch (n) {
        0 => 'Sab kaam pehle se band hain.',
        1 => '1 kaam band ho gaya.',
        _ => '$n kaam band ho gaye.',
      };
}

/// E4 (#1828 / #1831): the worker's match skills as switches, plus clear-all —
/// his exit from being shown to employers, short of deleting the account.
/// Pushed from the Profile tab.
class MatchSkillsScreen extends StatelessWidget {
  const MatchSkillsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<MatchSkillsCubit>(
      create: (_) => locator<MatchSkillsCubit>()..load(),
      child: const _MatchSkillsView(),
    );
  }
}

class _MatchSkillsView extends StatelessWidget {
  const _MatchSkillsView();

  /// A 400 (not in the vocabulary) or 404 (not held) is a stale list, not
  /// something the worker can fix — the list is re-read, so "try again" is the
  /// honest move. Anything else names its real cause.
  static String _writeReason(Failure f) => switch (f) {
        InvalidRequestFailure() => MatchSkillsCopy.saveFailed,
        ServerFailure(statusCode: 404) => MatchSkillsCopy.saveFailed,
        _ => failureReason(f).reason,
      };

  void _snack(BuildContext context, String text) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    // [BbScaffold] with its own chrome off (the header bleeds into the status
    // bar; the list owns its gutter), kept for its `bottomBarInset` contract:
    // it publishes 0 on mount, so while loading / failed / empty — no docked
    // bar — the Feedback pill does not keep the previous page's bar height.
    return BbScaffold(
      padded: false,
      safeArea: false,
      body: MultiBlocListener(
        listeners: <BlocListener<MatchSkillsCubit, MatchSkillsState>>[
          BlocListener<MatchSkillsCubit, MatchSkillsState>(
            listenWhen: (MatchSkillsState a, MatchSkillsState b) =>
                a.writeSeq != b.writeSeq && b.writeFailure != null,
            listener: (BuildContext context, MatchSkillsState s) =>
                _snack(context, _writeReason(s.writeFailure!)),
          ),
          BlocListener<MatchSkillsCubit, MatchSkillsState>(
            listenWhen: (MatchSkillsState a, MatchSkillsState b) =>
                a.clearSeq != b.clearSeq && b.turnedOff != null,
            // The switches this clear-all turned off, as the list shows them
            // — never the server's `cleared` (#1850), and nothing about how
            // many employers can see him.
            listener: (BuildContext context, MatchSkillsState s) =>
                _snack(context, MatchSkillsCopy.turnedOff(s.turnedOff!)),
          ),
        ],
        child: Column(
          children: <Widget>[
            ShiftBlueHeader(
              title: MatchSkillsCopy.header,
              compact: true,
              onBack: () => Navigator.of(context).maybePop(),
            ),
            Expanded(
              child: SafeArea(
                top: false,
                bottom: false,
                child: BlocBuilder<MatchSkillsCubit, MatchSkillsState>(
                  builder: (BuildContext context, MatchSkillsState state) =>
                      switch (state.status) {
                    MatchSkillsStatus.loading => const BbStatusView.loading(),
                    MatchSkillsStatus.failed => BbStatusView(
                        icon: failureReason(state.failure).icon,
                        title: MatchSkillsCopy.loadFailed,
                        subtitle: failureReason(state.failure).reason,
                        action: FilledButton(
                          onPressed: () =>
                              context.read<MatchSkillsCubit>().load(),
                          child: const Text('Dobara try karein'),
                        ),
                      ),
                    MatchSkillsStatus.ready => state.skills.isEmpty
                        ? const BbStatusView(
                            icon: Icons.work_off_rounded,
                            title: MatchSkillsCopy.empty,
                          )
                        : _SkillList(state: state),
                  },
                ),
              ),
            ),
            const _ClearAllBar(),
          ],
        ),
      ),
    );
  }
}

class _SkillList extends StatelessWidget {
  const _SkillList({required this.state});

  final MatchSkillsState state;

  @override
  Widget build(BuildContext context) {
    final MatchSkillsCubit cubit = context.read<MatchSkillsCubit>();
    return ListView(
      padding: KitInsets.list(
        MediaQuery.sizeOf(context).width,
        max: OnboardingLayout.maxContentWidth,
        gutter: 16,
      ).copyWith(top: 20, bottom: 16 + FeedbackFabInset.of(context)),
      children: <Widget>[
        Text(
          MatchSkillsCopy.title,
          style: OnboardingTypography.anek(size: 20, weight: FontWeight.w800),
        ),
        const SizedBox(height: 6),
        Text(
          MatchSkillsCopy.hint,
          style: OnboardingTypography.inter(
            size: 14,
            height: 1.45,
            color: OnboardingColors.ink600,
          ),
        ),
        const SizedBox(height: 16),
        // Settings' grouped-card idiom: the toggle rows draw their own
        // hairlines, so no Divider goes between them.
        KitCard(
          padding: EdgeInsets.zero,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(OnboardingRadii.card),
            child: Column(
              children: <Widget>[
                for (final MatchSkill skill in state.skills)
                  _SkillRow(
                    skill: skill,
                    saving: state.savingId == skill.skillId,
                    locked: state.busy,
                    onChanged: (bool v) =>
                        cubit.setWants(skill.skillId, wants: v),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _SkillRow extends StatelessWidget {
  const _SkillRow({
    required this.skill,
    required this.saving,
    required this.locked,
    required this.onChanged,
  });

  final MatchSkill skill;
  final bool saving;
  final bool locked;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return BbListRow.toggle(
      key: ValueKey<String>('match-skill-${skill.skillId}'),
      icon: Icons.construction_rounded,
      title: skill.label,
      subtitle: saving ? 'Save ho raha hai…' : (skill.wants ? 'Chalu' : 'Band'),
      value: skill.wants,
      enabled: !locked,
      onChanged: onChanged,
    );
  }
}

/// Clear-all, docked so it stays reachable under a long list. Shown only when
/// there is a list to clear; disabled once every row is already off.
class _ClearAllBar extends StatelessWidget {
  const _ClearAllBar();

  Future<void> _confirm(BuildContext context) async {
    final MatchSkillsCubit cubit = context.read<MatchSkillsCubit>();
    final bool ok = await showBbConfirm(
      context,
      title: MatchSkillsCopy.clearAllConfirmTitle,
      message: MatchSkillsCopy.clearAllConfirm,
      confirmLabel: 'Haan, band karein',
      destructive: true,
      barrierDismissible: false,
    );
    if (!ok || !context.mounted) return;
    await cubit.clearAll();
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<MatchSkillsCubit, MatchSkillsState>(
      builder: (BuildContext context, MatchSkillsState state) {
        if (state.status != MatchSkillsStatus.ready || state.skills.isEmpty) {
          return const SizedBox.shrink();
        }
        return KitDockedBar(
          maxWidth: OnboardingLayout.maxContentWidth,
          child: BbButton(
            label: MatchSkillsCopy.clearAll,
            allowMultilineLabel: true,
            variant: BbButtonVariant.danger,
            size: BbButtonSize.md,
            block: true,
            loading: state.clearing,
            iconLeft: Icons.block_rounded,
            onPressed:
                state.busy || !state.anyOn ? null : () => _confirm(context),
          ),
        );
      },
    );
  }
}
