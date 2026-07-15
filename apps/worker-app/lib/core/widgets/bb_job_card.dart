import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_festive_card.dart';
import 'bb_tag.dart';

/// Immutable contents of a [BbJobCard] — the worker-facing job summary the Feed
/// deck renders. Pure data, no behaviour.
class BbJobCardData {
  const BbJobCardData({
    required this.title,
    this.company,
    this.verified = false,
    this.payBand,
    required this.place,
    this.shift,
    this.tags = const <String>[],
    this.spotsLeft,
  });

  final String title;

  /// Employer name — NULL on the real feed. Employer names are PII (CLAUDE.md
  /// §2) and `GET /feed` deliberately does not return one. Optional (and unset
  /// in production) because an earlier build invented a company name per card
  /// from `jobId.hashCode` and rendered it as fact.
  final String? company;

  /// Pay band — NULL on the real feed; no worker-facing route serves pay.
  final String? payBand;

  final String place;

  /// Shift — NULL on the real feed.
  final String? shift;

  /// Only ever shown for a REAL employer; never a badge on an invented name.
  final bool verified;

  /// Requirement tags — empty on the real feed.
  final List<String> tags;

  /// Remaining spots — NULL on the real feed.
  final int? spotsLeft;
}

/// The festive job card — `.aw-job` (ui.css §160–172). A purely **visual** card
/// (no drag, no Skip/Apply CTA row — the Feed deck layers those on later). Wraps
/// [BbFestiveCard] so each job leads with the truck-art double-vermilion frame.
///
/// Pass [onTitleTap] to make the title open the job detail; the rest is static.
class BbJobCard extends StatelessWidget {
  const BbJobCard({super.key, required this.data, this.onTitleTap});

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  @override
  Widget build(BuildContext context) {
    return BbFestiveCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _TitleRow(data: data, onTitleTap: onTitleTap),
          const SizedBox(height: AppSpacing.s3),
          _FactsRow(data: data),
          if (data.tags.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: data.tags.map(BbTag.new).toList(),
            ),
          ],
          if (data.spotsLeft != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            _QuotaRow(spotsLeft: data.spotsLeft!),
          ],
        ],
      ),
    );
  }
}

/// Title + company (left, flexes) and the saffron logo tile (right).
class _TitleRow extends StatelessWidget {
  const _TitleRow({required this.data, required this.onTitleTap});

  final BbJobCardData data;
  final VoidCallback? onTitleTap;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              GestureDetector(
                onTap: onTitleTap,
                child: Text(
                  data.title,
                  style: AppTypography.display(
                    size: AppTypography.sizeXl,
                    weight: FontWeight.w800,
                  ),
                ),
              ),
              // Only when a REAL employer name exists (never on the live feed).
              if (data.company != null) ...<Widget>[
                const SizedBox(height: AppSpacing.s1),
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        data.company!,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.body(
                          weight: FontWeight.w600,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ),
                    if (data.verified) ...<Widget>[
                      const SizedBox(width: AppSpacing.s1),
                      const Icon(
                        Icons.verified,
                        size: 15,
                        color: AppColors.success,
                      ),
                    ],
                  ],
                ),
              ],
            ],
          ),
        ),
        const SizedBox(width: AppSpacing.s3),
        const _LogoTile(),
      ],
    );
  }
}

/// 50×50 saffron logo tile standing in for the employer mark.
class _LogoTile extends StatelessWidget {
  const _LogoTile();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 50,
      height: 50,
      decoration: const BoxDecoration(
        color: AppColors.saffron100,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.md)),
      ),
      child: const Icon(
        Icons.build_outlined,
        size: 24,
        color: AppColors.saffron700,
      ),
    );
  }
}

/// Place · shift · pay facts, wrapping on narrow widths.
class _FactsRow extends StatelessWidget {
  const _FactsRow({required this.data});

  final BbJobCardData data;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.s4,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        // Place is the only fact the real feed carries. Shift and pay render
        // ONLY if a real source ever supplies them — never invented.
        _Fact(icon: Icons.place_outlined, child: _factText(data.place)),
        if (data.shift != null)
          _Fact(icon: Icons.schedule, child: _factText(data.shift!)),
        if (data.payBand != null)
          _Fact(
            icon: Icons.currency_rupee,
            child: Text(
              data.payBand!,
              style: AppTypography.mono(
                weight: FontWeight.w700,
                color: AppColors.textPrimary,
              ),
            ),
          ),
      ],
    );
  }

  Text _factText(String value) => Text(
        value,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textSecondary,
        ),
      );
}

/// One icon + label fact unit.
class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.child});

  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 15, color: AppColors.textFaint),
        const SizedBox(width: AppSpacing.s1),
        child,
      ],
    );
  }
}

/// "N spots left" remaining-quota line.
class _QuotaRow extends StatelessWidget {
  const _QuotaRow({required this.spotsLeft});

  final int spotsLeft;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        const Icon(
          Icons.groups_outlined,
          size: 15,
          color: AppColors.textMuted,
        ),
        const SizedBox(width: AppSpacing.s1),
        Text.rich(
          TextSpan(
            children: <TextSpan>[
              TextSpan(
                text: '$spotsLeft spots',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                  color: AppColors.brandPress,
                ),
              ),
              TextSpan(
                text: ' left',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: AppColors.textMuted,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
