import 'package:flutter/material.dart';

import '../../../../core/data/models.dart';
import '../../../../core/error/payer_failure.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_field_error.dart';

/// Shown where a company form's trade picker goes while the 16-trade catalogue
/// (`GET /payer/posting-trades`) loads.
const String kPostingTradesLoadingLabel = 'Loading roles…';

/// The trade picker's label on every form that picks one of the 16 trades —
/// and on [PostingTradePickerPlaceholder], which stands in for it.
const String kPostingTradePickerLabel = 'Role';

/// #2635 — what a form shows where its trade picker goes until the 16 trades
/// are there to pick from: the picker's label, then [kPostingTradesLoadingLabel]
/// while the catalogue loads, or [PostingTradesUnavailable] (the real cause and
/// a Retry) if it did not. [errorText] is the role's inline error, so a refusal
/// placed at the role always has a spot to show under.
///
/// One copy for the post form, Edit job and the AI chat's draft panel.
class PostingTradePickerPlaceholder extends StatelessWidget {
  const PostingTradePickerPlaceholder({
    super.key,
    required this.loading,
    required this.failure,
    required this.onRetry,
    this.errorText,
  });

  /// The catalogue read is in flight.
  final bool loading;

  /// Why the catalogue did not load; null when it answered but listed no trade.
  final PayerFailure? failure;

  final VoidCallback onRetry;

  /// The role's inline error; null shows none.
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          kPostingTradePickerLabel,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        if (loading)
          Text(
            kPostingTradesLoadingLabel,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          )
        else
          PostingTradesUnavailable(failure: failure, onRetry: onRetry),
        BbFieldError(text: errorText),
      ],
    );
  }
}

/// #2635 — what stands in for the trade picker when the 16-trade catalogue did
/// not load: the real reason and a Retry.
///
/// A company job must name one of the 16 trades before it can go live, so a
/// form never falls back to a free role list or the flat skill picker here — it
/// says why it cannot offer the trades and lets the payer ask again. [failure]
/// is null when the catalogue answered but listed no trade.
class PostingTradesUnavailable extends StatelessWidget {
  const PostingTradesUnavailable({
    super.key,
    required this.failure,
    required this.onRetry,
  });

  final PayerFailure? failure;
  final VoidCallback onRetry;

  /// The line shown, naming the real cause.
  static String messageFor(PayerFailure? failure) => failure == null
      ? 'No trades are open for posting right now. Try again in a moment.'
      : 'The 16 trades did not load. ${failure.message}';

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          messageFor(failure),
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.warning,
            height: 1.4,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        // The only way forward from here, so a full-size target (md, not the
        // quiet 36px sm).
        BbButton(
          label: 'Retry',
          variant: BbButtonVariant.secondary,
          size: BbButtonSize.md,
          iconLeft: Icons.refresh_rounded,
          onPressed: onRetry,
        ),
      ],
    );
  }
}

/// The role-specific posting form (migration 0141).
///
/// The worker's trade interview and a vacancy now ask the same facts. Chips the
/// server marks `match: true` add a match skill and change reach; the rest are
/// requirements the employer's candidate list can lead with. The base trade
/// skill is always in the match set, even with no chips selected; the rung is
/// display-only and never changes who sees the posting.
///
/// The widget is PRESENTATION ONLY: it hands back the selected rung and answer
/// map, and the screen derives `matchSkillIds` through
/// [PostingTradeForm.matchSkillIdsFor] and asks the server for the reach count.
class TradePostingFields extends StatelessWidget {
  const TradePostingFields({
    super.key,
    required this.trade,
    required this.tradeLevel,
    required this.answers,
    required this.onChanged,
  });

  final PostingTradeForm trade;
  final String tradeLevel;
  final Map<String, List<String>> answers;
  final void Function(String tradeLevel, Map<String, List<String>> answers)
      onChanged;

  void _toggleRung(String rung) {
    onChanged(tradeLevel == rung ? '' : rung, answers);
  }

  void _toggleOption(PostingTradeQuestion question, String optionKey) {
    final List<String> current =
        answers[question.questionKey] ?? const <String>[];
    final List<String> next;
    if (question.singleSelect) {
      next = current.contains(optionKey) ? <String>[] : <String>[optionKey];
    } else {
      next = current.contains(optionKey)
          ? current.where((String key) => key != optionKey).toList()
          : <String>[...current, optionKey];
    }
    final Map<String, List<String>> copy = <String, List<String>>{
      for (final MapEntry<String, List<String>> e in answers.entries)
        e.key: List<String>.of(e.value),
    };
    if (next.isEmpty) {
      copy.remove(question.questionKey);
    } else {
      copy[question.questionKey] = next;
    }
    onChanged(tradeLevel, copy);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          'Rung',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s1),
        Text(
          'Display only — the worker reads it as the role’s level. It does not '
          'change who the posting reaches.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
            height: 1.4,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            for (final PostingTradeRung rung in trade.ladder)
              BbChip(
                label: humaniseTradeKey(rung.rung),
                selected: tradeLevel == rung.rung,
                onTap: () => _toggleRung(rung.rung),
              ),
          ],
        ),
        for (final PostingTradeQuestion question
            in trade.questions) ...<Widget>[
          const SizedBox(height: AppSpacing.s4),
          Text(
            question.prompt,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final PostingTradeOption option in question.options)
                BbChip(
                  label:
                      option.match ? '${option.label} · Match' : option.label,
                  selected: (answers[question.questionKey] ?? const <String>[])
                      .contains(option.optionKey),
                  onTap: () => _toggleOption(question, option.optionKey),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

/// `setter_programmer` → `Setter Programmer`; every key is a closed slug.
String humaniseTradeKey(String key) => key
    .split('_')
    .where((String word) => word.isNotEmpty)
    .map((String word) => '${word[0].toUpperCase()}${word.substring(1)}')
    .join(' ');
