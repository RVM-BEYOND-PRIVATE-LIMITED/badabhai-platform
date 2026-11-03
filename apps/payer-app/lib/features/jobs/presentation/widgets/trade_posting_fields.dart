import 'package:flutter/material.dart';

import '../../../../core/data/models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_chip.dart';

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
