import 'package:flutter/material.dart';

import '../../../../core/data/models.dart';
import '../../../../core/error/payer_failure.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_field.dart';
import '../../../../core/widgets/bb_field_error.dart';
import '../../../../core/theme/bb_palette.dart';

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
    final BbPalette p = context.bb;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          kPostingTradePickerLabel,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: p.textPrimary,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        if (loading)
          Text(
            kPostingTradesLoadingLabel,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: p.textMuted,
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
    final BbPalette p = context.bb;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          messageFor(failure),
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: p.warning,
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

/// The catalogue-backed trade picker: the picked trade's server label in the
/// field, then a searchable sheet whose trades are grouped under the server's
/// department headings. Every name shown comes from the catalogue reply.
class PostingTradePicker extends StatelessWidget {
  const PostingTradePicker({
    super.key,
    required this.catalogue,
    required this.value,
    required this.onSelected,
    this.errorText,
  });

  /// Key of the closed field (for widget tests).
  @visibleForTesting
  static const Key fieldKey = Key('posting_trade_picker_field');

  /// Key of the sheet's search input (for widget tests).
  @visibleForTesting
  static const Key searchFieldKey = Key('posting_trade_picker_search');

  static const String searchHint = 'Search roles';
  static const String emptyHint = 'Nothing matches. Try another word.';

  final List<PostingTradeCatalogueRow> catalogue;
  final String? value;
  final ValueChanged<String> onSelected;
  final String? errorText;

  Future<void> _open(BuildContext context) async {
    final String? picked = await showModalBottomSheet<String>(
      context: context,
      sheetAnimationStyle: AppMotion.sheetStyle(context),
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      backgroundColor: context.bb.card,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
      ),
      builder: (_) => _PostingTradePickerSheet(
        catalogue: catalogue,
        value: value,
      ),
    );
    if (picked != null) onSelected(picked);
  }

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final String label = postingTradeLabelFor(value, catalogue: catalogue);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          kPostingTradePickerLabel,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: p.textPrimary,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Semantics(
          button: true,
          child: InkWell(
            key: fieldKey,
            onTap: () => _open(context),
            borderRadius: BorderRadius.circular(AppRadii.md),
            child: InputDecorator(
              decoration: InputDecoration(
                suffixIcon: Icon(
                  Icons.expand_more_rounded,
                  color: p.textMuted,
                ),
              ),
              child: Text(
                label.isEmpty ? '— pick the role —' : label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.body(size: AppTypography.sizeBase),
              ),
            ),
          ),
        ),
        BbFieldError(text: errorText),
      ],
    );
  }
}

class _PostingTradePickerSheet extends StatefulWidget {
  const _PostingTradePickerSheet({
    required this.catalogue,
    required this.value,
  });

  final List<PostingTradeCatalogueRow> catalogue;
  final String? value;

  @override
  State<_PostingTradePickerSheet> createState() =>
      _PostingTradePickerSheetState();
}

class _PostingTradePickerSheetState extends State<_PostingTradePickerSheet> {
  final TextEditingController _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final String query = _query.trim().toLowerCase();
    final List<PostingTradeCatalogueRow> visible = query.isEmpty
        ? widget.catalogue
        : widget.catalogue
            .where((PostingTradeCatalogueRow row) =>
                row.roleLabel.toLowerCase().contains(query))
            .toList(growable: false);

    final List<Widget> rows = <Widget>[];
    String? department;
    for (final PostingTradeCatalogueRow row in visible) {
      if (row.department != department) {
        department = row.department;
        if (rows.isNotEmpty) {
          rows.add(const SizedBox(height: AppSpacing.s3));
        }
        rows.add(Text(
          row.departmentLabel.isEmpty
              ? humaniseTradeKey(row.department)
              : row.departmentLabel,
          style: AppTypography.eyebrow(color: p.textMuted),
        ));
        rows.add(const SizedBox(height: AppSpacing.s1));
      }
      final bool picked = row.roleKind == widget.value;
      rows.add(ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(
          row.roleLabel,
          style: AppTypography.body(
            size: AppTypography.sizeBase,
            weight: picked ? FontWeight.w700 : FontWeight.w400,
          ),
        ),
        trailing: picked ? Icon(Icons.check_rounded, color: p.textBrand) : null,
        onTap: () => Navigator.of(context).pop(row.roleKind),
      ));
    }

    final double keyboard = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: AppSpacing.gutter,
          right: AppSpacing.gutter,
          bottom: keyboard + AppSpacing.s4,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                'Pick a role',
                style: AppTypography.heading(size: AppTypography.sizeLg),
              ),
              const SizedBox(height: AppSpacing.s3),
              BbField(
                fieldKey: PostingTradePicker.searchFieldKey,
                controller: _search,
                hint: PostingTradePicker.searchHint,
                icon: Icons.search_rounded,
                textInputAction: TextInputAction.search,
                onChanged: (String v) => setState(() => _query = v),
              ),
              const SizedBox(height: AppSpacing.s2),
              if (rows.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.s5),
                  child: Text(
                    PostingTradePicker.emptyHint,
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: p.textMuted,
                    ),
                  ),
                )
              else
                ...rows,
            ],
          ),
        ),
      ),
    );
  }
}

/// What stands where a picked trade's form will go while it loads, or after it
/// failed — with a Retry, so picking a trade never leaves a silent blank.
class PostingTradeFormStatus extends StatelessWidget {
  const PostingTradeFormStatus({
    super.key,
    required this.loading,
    required this.failure,
    required this.onRetry,
  });

  static const String loadingLabel = 'Loading trade requirements…';

  final bool loading;
  final PayerFailure? failure;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    if (loading) {
      return Text(
        loadingLabel,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: p.textMuted,
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          failure == null
              ? 'The trade requirements did not load.'
              : 'The trade requirements did not load. ${failure!.message}',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: p.warning,
            height: 1.4,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
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
    final BbPalette p = context.bb;
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
            color: p.textMuted,
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
