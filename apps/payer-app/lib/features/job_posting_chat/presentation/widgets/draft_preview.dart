import 'package:flutter/material.dart';

import '../../../../core/data/job_posting_chat_models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/pay_format.dart';
import '../../../../core/widgets/bb_badge.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_card.dart';

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
class DraftPreview extends StatelessWidget {
  const DraftPreview({
    super.key,
    required this.draft,
    required this.ready,
    required this.publishing,
    required this.onPublish,
  });

  final JobPostingDraft draft;

  /// The ENGINE's readiness decision (`draft_ready`) — server-side and
  /// deterministic. The client never decides this.
  final bool ready;

  final bool publishing;
  final VoidCallback onPublish;

  @override
  Widget build(BuildContext context) {
    final List<(String, String)> rows = <(String, String)>[
      if (draft.roleTitle != null) ('Role', draft.roleTitle!),
      if (draft.locationLabel != null) ('Location', draft.locationLabel!),
      if (draft.vacancyBand != null) ('Vacancies', draft.vacancyBand!),
      if (_pay != null) ('Pay', _pay!),
      if (draft.shift != null) ('Shift', draft.shift!),
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
                  style: AppTypography.display(
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
          BbButton(
            label: kDraftPublishLabel,
            block: true,
            iconLeft: Icons.send,
            loading: publishing,
            // A SOFT gate, and the server is still the authority: the button
            // stays visible and keeps its ≥48px target, but it is only armed
            // once the engine says the draft is ready AND the two fields the
            // create route requires are present. Publishing early would just be
            // a 400 the payer cannot act on.
            onPressed:
                (ready && draft.hasRequiredFields && !publishing) ? onPublish : null,
          ),
        ],
      ),
    );
  }

  /// "₹18,000 – ₹24,000" from whichever bound(s) the server holds. Never
  /// invents the missing half.
  String? get _pay {
    final int? min = draft.payMin;
    final int? max = draft.payMax;
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
          width: 104,
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
