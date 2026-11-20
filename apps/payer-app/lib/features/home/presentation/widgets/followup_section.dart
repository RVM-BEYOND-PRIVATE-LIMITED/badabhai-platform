import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/unlock_followup_models.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_card.dart';
import '../../../../core/widgets/bb_toast.dart';
import '../../../../core/theme/bb_palette.dart';
import '../cubit/followup_cubit.dart';

/// The Home section's card. Public so a widget test can prove the section is
/// absent when the read is off/empty.
const Key kFollowupCardKey = Key('home_followup_card');

/// The retry card shown when the due-list read fails (a `503` or transport
/// failure). A `404` (feature off) never renders it.
const Key kFollowupRetryCardKey = Key('home_followup_retry_card');
const Key kFollowupRetryKey = Key('home_followup_retry');

/// The row for one due contact (unlock id, opaque by contract).
Key followupRowKey(String unlockId) => Key('home_followup_row_$unlockId');

/// One of a row's three answer buttons.
Key followupAnswerKey(String unlockId, UnlockFollowupOutcome outcome) =>
    Key('home_followup_answer_${unlockId}_${outcome.wire}');

const int _kInlineRows = 3;
const List<String> _kMonths = <String>[
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// Home's FOLLOW-UP section — "Did you hire this person?".
///
/// FACELESS by design: a row says only "Unlocked contact", the grant date and
/// the current answer. No worker name, phone, trade or posting is ever shown.
/// The whole section disappears on a 404 (feature off), an error, or an empty
/// page; a read failure never fabricates a "nothing due" card.
class FollowupSection extends StatelessWidget {
  const FollowupSection({super.key});

  @override
  Widget build(BuildContext context) {
    final FollowupCubit cubit = context.read<FollowupCubit>();
    return BlocBuilder<FollowupCubit, FollowupState>(
      bloc: cubit,
      builder: (BuildContext context, FollowupState state) {
        if (state.status == FollowupStatus.error) {
          return _RetryCard(cubit: cubit);
        }
        if (!state.visible) return const SizedBox.shrink();
        final List<UnlockFollowupItem> shown =
            state.items.take(_kInlineRows).toList(growable: false);
        return Padding(
          padding: const EdgeInsets.only(top: AppSpacing.s5),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                'FOLLOW-UP',
                style: AppTypography.eyebrow(color: context.bb.textMuted),
              ),
              const SizedBox(height: AppSpacing.s2),
              BbCard(
                key: kFollowupCardKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    _Header(count: state.items.length),
                    const SizedBox(height: AppSpacing.s3),
                    for (int i = 0; i < shown.length; i++) ...<Widget>[
                      if (i > 0) const SizedBox(height: AppSpacing.s3),
                      _FollowupRow(
                        cubit: cubit,
                        item: shown[i],
                        state: state,
                      ),
                    ],
                    if (state.items.length > _kInlineRows) ...<Widget>[
                      const SizedBox(height: AppSpacing.s3),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: BbButton(
                          label: 'View all ${state.items.length}',
                          variant: BbButtonVariant.ghost,
                          size: BbButtonSize.sm,
                          iconRight: Icons.chevron_right_rounded,
                          onPressed: () => _openSheet(context, cubit),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Container(
          width: AppSpacing.s8,
          height: AppSpacing.s8,
          decoration: BoxDecoration(
            color: p.actionTint,
            borderRadius: BorderRadius.circular(AppRadii.sm),
          ),
          child:
              Icon(Icons.handshake_rounded, size: 20, color: p.actionPressed),
        ),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'Did you hire this person?',
                style: AppTypography.heading(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                count == 1
                    ? 'One contact you unlocked is waiting for an answer.'
                    : '$count contacts you unlocked are waiting for an answer.',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: p.textMuted,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _FollowupRow extends StatelessWidget {
  const _FollowupRow({
    required this.cubit,
    required this.item,
    required this.state,
  });

  final FollowupCubit cubit;
  final UnlockFollowupItem item;
  final FollowupState state;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final UnlockFollowupOutcome? pending =
        state.pendingOutcomeFor(item.unlockId);
    final bool busy = pending != null;
    return Container(
      key: followupRowKey(item.unlockId),
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: p.inset,
        borderRadius: BorderRadius.circular(AppRadii.sm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.person_rounded, size: 20, color: p.textBrand),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      'Unlocked contact',
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${_grantedLabel(item.grantedAt)} · '
                      '${item.outcome?.label ?? 'No answer yet'}',
                      style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        color: p.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final UnlockFollowupOutcome outcome
                  in UnlockFollowupOutcome.values)
                BbButton(
                  key: followupAnswerKey(item.unlockId, outcome),
                  label: outcome.label,
                  variant: outcome == item.outcome
                      ? BbButtonVariant.tonal
                      : BbButtonVariant.secondary,
                  size: BbButtonSize.sm,
                  loading: pending == outcome,
                  onPressed: busy
                      ? null
                      : () => _answer(context, cubit, item, outcome),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

Future<void> _answer(
  BuildContext context,
  FollowupCubit cubit,
  UnlockFollowupItem item,
  UnlockFollowupOutcome outcome,
) async {
  final FollowupAnswerResult result = await cubit.answer(item, outcome);
  if (!context.mounted) return;
  if (result == FollowupAnswerResult.rateLimited) {
    showBbToast(
      context,
      title: 'Too many answers',
      message: 'Please try again in a little while.',
      icon: Icons.schedule_rounded,
    );
  } else if (result == FollowupAnswerResult.failed) {
    showBbToast(
      context,
      title: "Couldn't save answer",
      message: 'Please try again.',
      icon: Icons.refresh_rounded,
    );
  }
}

void _openSheet(BuildContext context, FollowupCubit cubit) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: context.bb.card,
    barrierColor: context.bb.scrim,
    sheetAnimationStyle: AppMotion.sheetStyle(context),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
    ),
    builder: (BuildContext sheetContext) => _FollowupSheet(cubit: cubit),
  );
}

class _FollowupSheet extends StatelessWidget {
  const _FollowupSheet({required this.cubit});

  final FollowupCubit cubit;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<FollowupCubit, FollowupState>(
      bloc: cubit,
      builder: (BuildContext context, FollowupState state) {
        return SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              0,
              AppSpacing.gutter,
              AppSpacing.s5,
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(context).height * 0.8,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Text(
                    'Contacts to follow up',
                    style: AppTypography.heading(size: AppTypography.sizeLg),
                  ),
                  const SizedBox(height: AppSpacing.s1),
                  Text(
                    'Answer what happened after each unlock. '
                    'Answered contacts leave this list.',
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: context.bb.textMuted,
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  if (state.items.isEmpty)
                    Text(
                      'All caught up.',
                      style: AppTypography.body(
                        color: context.bb.textMuted,
                      ),
                    )
                  else
                    Flexible(
                      child: ListView.separated(
                        shrinkWrap: true,
                        itemCount: state.items.length,
                        separatorBuilder: (_, __) =>
                            const SizedBox(height: AppSpacing.s2),
                        itemBuilder: (BuildContext context, int index) =>
                            _FollowupRow(
                          cubit: cubit,
                          item: state.items[index],
                          state: state,
                        ),
                      ),
                    ),
                  if (state.hasMore) ...<Widget>[
                    const SizedBox(height: AppSpacing.s3),
                    BbButton(
                      label: state.loadingMore ? 'Loading…' : 'Load more',
                      variant: BbButtonVariant.secondary,
                      size: BbButtonSize.md,
                      loading: state.loadingMore,
                      onPressed:
                          state.loadingMore ? null : () => cubit.loadMore(),
                    ),
                  ],
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

String _grantedLabel(String grantedAt) {
  final DateTime? parsed = DateTime.tryParse(grantedAt)?.toLocal();
  if (parsed == null) return 'Unlocked';
  return 'Unlocked ${parsed.day} ${_kMonths[parsed.month - 1]}';
}


/// The read failed (`503`/transport): one honest retry, never a fabricated
/// "nothing due" card. A `404` is mapped to [FollowupStatus.off] and stays
/// invisible, so a switched-off feature still looks exactly as it did before.
class _RetryCard extends StatelessWidget {
  const _RetryCard({required this.cubit});

  final FollowupCubit cubit;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.s5),
      child: BbCard(
        key: kFollowupRetryCardKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Text(
              'Could not load follow-ups',
              style: AppTypography.heading(
                size: AppTypography.sizeBase,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s1),
            Text(
              'Nothing has changed. Try again to see which contacts are due.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: p.textMuted,
                height: 1.4,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            Align(
              alignment: Alignment.centerLeft,
              child: BbButton(
                buttonKey: kFollowupRetryKey,
                label: 'Try again',
                variant: BbButtonVariant.secondary,
                size: BbButtonSize.sm,
                onPressed: () => cubit.load(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
