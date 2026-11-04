import 'package:flutter/material.dart';

import '../../../../core/data/job_posting_chat_models.dart';
import '../../../../core/data/models.dart';
import '../../../../core/error/payer_failure.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/pay_format.dart';
import '../../../../core/widgets/bb_badge.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_card.dart';
import '../../../../core/widgets/bb_field.dart';
import '../../../../core/widgets/bb_form_errors.dart';
import '../../../../core/widgets/bb_shake.dart';
import '../../../jobs/presentation/widgets/trade_posting_fields.dart'
    show PostingTradePickerPlaceholder, kPostingTradePickerLabel;

/// Heading of the structured draft the payer reviews before anything is created.
const String kDraftPreviewTitle = 'Your job posting';

/// Publish CTA — the ONLY thing that creates a posting. Nothing is created while
/// the chat is running.
const String kDraftPublishLabel = 'Publish this job';

/// Shown while the engine has not called the draft ready.
const String kDraftNotReadyNote =
    'Keep chatting — a few details are still missing.';

/// The structured preview of the server-held [JobPostingDraft].
///
/// It renders ONLY what the server has extracted. Nothing is inferred, defaulted
/// or filled in client-side: a field the engine has not captured is simply
/// absent, so the payer can never publish a value they were never asked for.
///
/// There is deliberately NO company/org row. The payer's own org name is
/// auto-filled server-side from `payers.orgNameEnc` at publish time and never
/// travels through the chat or the LLM (ADR-0035 §Decision 3) — the draft has no
/// such field to render.
///
/// Vacancy is shown as the BAND the server holds (`1` / `2-5` / …, ADR-0012),
/// never as a headcount.
///
/// #2635 — the job's TRADE is picked here, from the 16 the catalogue lists
/// ([trades]), and the draft is never published without one: a company job
/// matches only within those trades, and the posting this creates could never
/// go live without one. A Publish tap with no trade is refused AT the picker
/// (M7's inline error — scrolled to, shaken) and nothing is sent.
class DraftPreview extends StatefulWidget {
  const DraftPreview({
    super.key,
    required this.draft,
    required this.ready,
    required this.publishing,
    required this.roleKind,
    required this.onRoleKindChanged,
    required this.trades,
    required this.tradesLoading,
    required this.tradesFailure,
    required this.onRetryTrades,
    required this.area,
    required this.onAreaChanged,
    required this.onPublish,
  });

  final JobPostingDraft draft;

  /// The ENGINE's readiness decision (`draft_ready`) — server-side and
  /// deterministic. The client never decides this.
  final bool ready;

  final bool publishing;

  /// The publish-step trade pick (#2490) — one of [trades], or null while none
  /// is picked. Sent as `role_kind` on publish; required (#2635).
  final String? roleKind;
  final ValueChanged<String?> onRoleKindChanged;

  /// #2635 — the 16 trades to pick from, [tradesLoading] while they are read;
  /// when the read failed ([tradesFailure]) the picker says why and offers
  /// [onRetryTrades].
  final List<PostingTradeForm> trades;
  final bool tradesLoading;
  final PayerFailure? tradesFailure;
  final VoidCallback onRetryTrades;

  /// The publish-step area/locality (#2493), prefilled from `draft.area` and
  /// editable. Optional: blank stays absent (city-only card).
  final String area;
  final ValueChanged<String> onAreaChanged;

  final VoidCallback onPublish;

  @override
  State<DraftPreview> createState() => _DraftPreviewState();
}

/// The publish-step controls an inline error can point at (#2595).
enum _PublishField { trade }

class _DraftPreviewState extends State<DraftPreview> {
  late final TextEditingController _area = TextEditingController(
    text: widget.area,
  );

  /// The publish step's inline errors (#2595) — today, only the trade.
  final BbFormErrors<_PublishField> _form = BbFormErrors<_PublishField>();

  bool _isTrade(String? kind) =>
      kind != null &&
      widget.trades.any((PostingTradeForm t) => t.roleKind == kind);

  /// Why Publish cannot go yet, at the control to change.
  Map<_PublishField, String> _validate() => <_PublishField, String>{
        if (!_isTrade(widget.roleKind))
          _PublishField.trade: kPostingTradeRequiredMessage,
      };

  /// #2635 — a tap with no trade is refused AT the picker and nothing is sent.
  void _publish() {
    final Map<_PublishField, String> errors = _validate();
    if (errors.isNotEmpty) {
      setState(() => _form.show(errors));
      return;
    }
    widget.onPublish();
  }

  @override
  void didUpdateWidget(DraftPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Follow the parent's value (the draft filling in, or an external reset)
    // without clobbering what the payer is typing: only rewrite when the value
    // genuinely changed.
    if (widget.area != _area.text) {
      _area.value = TextEditingValue(
        text: widget.area,
        selection: TextSelection.collapsed(offset: widget.area.length),
      );
    }
  }

  @override
  void dispose() {
    _area.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // A picked trade clears its error; nothing new shows before a tap.
    if (!_form.isEmpty) _form.settle(_validate());
    final JobPostingDraft draft = widget.draft;
    final bool ready = widget.ready;
    final bool publishing = widget.publishing;
    final ValueChanged<String> onAreaChanged = widget.onAreaChanged;
    final List<(String, String)> rows = <(String, String)>[
      // `role_title` — "Job title", as the posting forms call it, so it never
      // reads as the Role (trade) picked below (#2635).
      if (draft.roleTitle != null) ('Job title', draft.roleTitle!),
      if (draft.locationLabel != null) ('Location', draft.locationLabel!),
      // #1727 — the coarse card city, beside the poster's own location wording
      // rather than instead of it: they are two different facts, and only this
      // one reaches a worker's card.
      if (draft.city != null) ('City', draft.city!),
      if (draft.vacancyBand != null) ('Vacancies', draft.vacancyBand!),
      if (_pay != null) ('Pay', _pay!),
      // What the band MEANS (#1727). Humanised — `in_hand` never reaches a
      // payer's eye, and neither do the other three enums below.
      if (_payType != null) ('Pay type', _payType!),
      if (_experience != null) ('Experience', _experience!),
      if (_shift != null) ('Shift', _shift!),
      if (_neededBy != null) ('Joining time', _neededBy!),
      if (draft.skillPhrases.isNotEmpty)
        ('Skills', draft.skillPhrases.join(' · ')),
      if (draft.requirements.isNotEmpty)
        ('Requirements', draft.requirements.join(' · ')),
      if (draft.benefits.isNotEmpty) ('Benefits', draft.benefits.join(' · ')),
    ];

    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  kDraftPreviewTitle,
                  style: AppTypography.heading(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              BbBadge(
                ready ? 'Ready' : 'In progress',
                tone: ready ? BbBadgeTone.success : BbBadgeTone.neutral,
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s3),
          if (rows.isEmpty)
            Text(
              'Nothing captured yet — answer a couple of questions above.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            )
          else
            for (final (String label, String value) in rows) ...<Widget>[
              _DraftRow(label: label, value: value),
              const SizedBox(height: AppSpacing.s2),
            ],
          if (draft.description != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s1),
            Text(
              draft.description!,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
          ],
          if (!ready) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            Text(
              kDraftNotReadyNote,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.s4),
          // #2493 — the COARSE locality, prefilled from the interview draft and
          // editable at publish. Optional: blank publishes with `area` absent
          // (the worker card then shows the city alone).
          BbField(
            label: 'Area / locality',
            controller: _area,
            hint: 'e.g. Chakan',
            onChanged: onAreaChanged,
          ),
          const SizedBox(height: AppSpacing.s4),
          // #2490 — the trade pick lives on the publish step because the
          // interview does not ask for one. #2635 — it is REQUIRED, and one of
          // the 16 trades: a company job matches only within them.
          BbShake(key: _form.anchor(_PublishField.trade), child: _tradeField()),
          const SizedBox(height: AppSpacing.s4),
          BbButton(
            label: kDraftPublishLabel,
            block: true,
            iconLeft: Icons.send_rounded,
            loading: publishing,
            // A SOFT gate, and the server is still the authority: the button
            // stays visible and keeps its ≥48px target, but it is only armed
            // once the engine says the draft is ready AND the two fields the
            // create route requires are present. Publishing early would just be
            // a 400 the payer cannot act on. The trade is checked on the tap
            // (#2635): without one it is refused at the picker, never a dead
            // button that does not say why (#2595).
            onPressed:
                (ready && draft.hasRequiredFields && !publishing) ? _publish : null,
          ),
        ],
      ),
    );
  }

  /// The trade picker — the catalogue's 16 trades — with its inline error.
  /// While they load, or if they did not, the same spot says so (with a
  /// Retry), so a refused Publish always has a control to point at.
  Widget _tradeField() {
    final List<PostingTradeForm> trades = widget.trades;
    if (!widget.tradesLoading && trades.isNotEmpty) {
      return BbSelect<String?>(
        label: kPostingTradePickerLabel,
        // Only ever a value the list holds (the dropdown requires it).
        value: _isTrade(widget.roleKind) ? widget.roleKind : null,
        items: <String?>[
          null,
          ...trades.map((PostingTradeForm t) => t.roleKind),
        ],
        labelOf: (String? kind) => kind == null
            ? '— pick the role —'
            : trades
                .firstWhere((PostingTradeForm t) => t.roleKind == kind)
                .roleLabel,
        errorText: _form[_PublishField.trade],
        onChanged: widget.onRoleKindChanged,
      );
    }
    return PostingTradePickerPlaceholder(
      loading: widget.tradesLoading,
      failure: widget.tradesFailure,
      onRetry: widget.onRetryTrades,
      errorText: _form[_PublishField.trade],
    );
  }

  /// "₹18,000 – ₹24,000" from whichever bound(s) the server holds. Never
  /// invents the missing half.
  /// `in_hand` → "In-hand". The shared humaniser both demand forms use.
  String? get _payType => jobPayTypeLabel(widget.draft.payType);

  /// `immediate` → "Immediate".
  String? get _neededBy =>
      widget.draft.neededBy == null ? null : agencyNeededByLabel(widget.draft.neededBy);

  /// `night` → "Night". The raw enum used to print here verbatim.
  String? get _shift => switch (widget.draft.shift) {
        'day' => 'Day',
        'night' => 'Night',
        'rotational' => 'Rotational',
        _ => null,
      };

  /// "1–4 yrs" / "5+ yrs" / "up to 2 yrs" — the same shape the agency job view
  /// prints, because either end may legitimately be absent ("5+ years" has no
  /// max) and 0 is a real value (a fresher), not a missing one.
  String? get _experience {
    final int? lo = widget.draft.minExperienceYears;
    final int? hi = widget.draft.maxExperienceYears;
    if (lo == null && hi == null) return null;
    if (lo != null && hi != null) return '$lo–$hi yrs';
    if (lo != null) return '$lo+ yrs';
    return 'up to $hi yrs';
  }

  String? get _pay {
    final int? min = widget.draft.payMin;
    final int? max = widget.draft.payMax;
    if (min == null && max == null) return null;
    if (min != null && max != null) {
      return '₹${formatIndianGrouped(min)} – ₹${formatIndianGrouped(max)}';
    }
    return '₹${formatIndianGrouped((min ?? max)!)}';
  }
}

class _DraftRow extends StatelessWidget {
  const _DraftRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        SizedBox(
          width: AppSpacing.labelCol,
          child: Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
            ),
          ),
        ),
      ],
    );
  }
}
