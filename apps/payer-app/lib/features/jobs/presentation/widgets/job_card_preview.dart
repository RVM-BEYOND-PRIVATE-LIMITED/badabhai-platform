import 'package:flutter/material.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/pay_format.dart';

/// The worker-app job card, mirrored for the payer's Preview step.
///
/// Every value is the payer's own input; a null/empty field hides its row.
/// The drawing follows the worker feed card: white paper, 1px hairline, the
/// cream salary box, the "Duty & Suvidhayein" chips and the same self-hosted
/// fonts (Kilimanjaro Sans / Inter).
class JobCardPreview extends StatelessWidget {
  const JobCardPreview({
    super.key,
    required this.title,
    required this.place,
    this.trade,
    this.payMin,
    this.payMax,
    this.payType,
    this.shift,
    this.experience,
    this.neededBy,
    this.description,
    this.benefits = const <String>[],
    this.requirements = const <String>[],
  });

  final String title;
  final String place;
  final String? trade;
  final int? payMin;
  final int? payMax;

  /// `in_hand | gross | ctc`.
  final String? payType;

  /// Human shift label ("Night").
  final String? shift;

  /// Human experience line ("1–4 yrs experience").
  final String? experience;

  /// Human urgency label ("Turant chahiye").
  final String? neededBy;

  final String? description;
  final List<String> benefits;
  final List<String> requirements;

  // The worker card's own palette, copied so this preview cannot drift from
  // the screen the worker actually sees.
  static const Color _paper = Color(0xFFFFFFFF);
  static const Color _border = Color(0xFFD8DEE9);
  static const Color _ink900 = Color(0xFF101828);
  static const Color _ink600 = Color(0xFF475069);
  static const Color _ink500 = Color(0xFF667085);
  static const Color _shiftBlue = Color(0xFF05194C);
  static const Color _salaryBg = Color(0xFFFFFBEB);
  static const Color _salaryBorder = Color(0xFFF59E0B);
  static const Color _payInk = Color(0xFF9A3412);
  static const Color _dutyGreyBg = Color(0xFFF1F5F9);
  static const Color _infoBg = Color(0xFFEFF6FF);
  static const Color _infoText = Color(0xFF1E40AF);

  String? get _payBand {
    final int? min = payMin;
    final int? max = payMax;
    if (min != null && max != null) {
      if (min == max) return '₹${formatIndianGrouped(min)}/mah';
      return '₹${formatIndianGrouped(min)}–${formatIndianGrouped(max)}/mah';
    }
    if (min != null) return '₹${formatIndianGrouped(min)}+/mah';
    if (max != null) return 'Up to ₹${formatIndianGrouped(max)}/mah';
    return null;
  }

  String? get _payNote => switch (payType) {
        'in_hand' => 'IN-HAND',
        'gross' => 'GROSS',
        'ctc' => 'CTC',
        _ => null,
      };

  @override
  Widget build(BuildContext context) {
    final String descriptionText = description?.trim() ?? '';
    final List<_DutyChip> chips = <_DutyChip>[
      if (shift != null && shift!.isNotEmpty)
        _DutyChip(
          label: '$shift Shift',
          icon: Icons.schedule_rounded,
          bg: _dutyGreyBg,
        ),
      if (experience != null && experience!.isNotEmpty)
        _DutyChip(
          label: experience!,
          icon: Icons.person_outline_rounded,
          bg: _dutyGreyBg,
        ),
      if (neededBy != null && neededBy!.isNotEmpty)
        _DutyChip(
          label: neededBy!,
          icon: Icons.bolt_rounded,
          bg: _infoBg,
        ),
      for (final String tag in requirements)
        if (tag.trim().isNotEmpty)
          _DutyChip(
            label: tag,
            icon: Icons.build_rounded,
            bg: _salaryBg,
          ),
      for (final String benefit in benefits)
        if (benefit.trim().isNotEmpty)
          _DutyChip(
            label: benefit,
            icon: Icons.card_giftcard_rounded,
            bg: _infoBg,
          ),
    ];

    return Container(
      decoration: BoxDecoration(
        color: _paper,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _border),
      ),
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (trade != null && trade!.isNotEmpty) ...<Widget>[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: _shiftBlue,
                borderRadius: BorderRadius.circular(AppRadii.chip),
              ),
              child: Text(
                trade!,
                style: AppTypography.body(
                  size: 11,
                  weight: FontWeight.w700,
                  color: _paper,
                  letterSpacing: 0.3,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
          ],
          Text(
            title.trim().isEmpty ? 'Job title' : title.trim(),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.header(
              size: 17,
              weight: FontWeight.w800,
              color: _ink900,
              height: 1.25,
              letterSpacing: 0,
            ),
          ),
          const SizedBox(height: 2),
          Row(
            children: <Widget>[
              const Icon(Icons.place_rounded, size: 14, color: _ink500),
              const SizedBox(width: 5),
              Flexible(
                child: Text(
                  place.trim().isEmpty ? 'Location not added' : place.trim(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.body(
                    size: 13,
                    color: _ink600,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
          if (_payBand != null) ...<Widget>[
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: _salaryBg,
                borderRadius: BorderRadius.circular(AppRadii.md),
                border: Border.all(color: _salaryBorder),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      Expanded(
                        child: Text(
                          'MAHINE KI SALARY',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppTypography.body(
                            size: 11,
                            weight: FontWeight.w700,
                            letterSpacing: 0.6,
                            color: _payInk,
                          ),
                        ),
                      ),
                      if (_payNote != null)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 3,
                          ),
                          decoration: BoxDecoration(
                            color: _paper,
                            borderRadius: BorderRadius.circular(999),
                            border: Border.all(color: _salaryBorder),
                          ),
                          child: Text(
                            _payNote!,
                            style: AppTypography.body(
                              size: 10,
                              weight: FontWeight.w800,
                              letterSpacing: 0.4,
                              color: _payInk,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _payBand!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.header(
                      size: 18,
                      weight: FontWeight.w800,
                      color: _payInk,
                      letterSpacing: 0,
                    ),
                  ),
                ],
              ),
            ),
          ],
          if (chips.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            Text(
              'Duty & Suvidhayein',
              style: AppTypography.body(
                size: 12,
                weight: FontWeight.w600,
                color: _ink600,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: chips),
          ],
          if (descriptionText.isNotEmpty) ...<Widget>[
            const SizedBox(height: 10),
            _ExpandableDescription(
              text: descriptionText,
              style: AppTypography.body(
                size: 13,
                color: _ink600,
                height: 1.4,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The card's description: three lines, then a "Read more" that reveals the
/// whole text. The dots are replaced by a real control so a long description
/// is never silently cut off in the payer's preview.
class _ExpandableDescription extends StatefulWidget {
  const _ExpandableDescription({required this.text, required this.style});

  final String text;
  final TextStyle style;

  @override
  State<_ExpandableDescription> createState() => _ExpandableDescriptionState();
}

class _ExpandableDescriptionState extends State<_ExpandableDescription> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final TextPainter painter = TextPainter(
          text: TextSpan(text: widget.text, style: widget.style),
          maxLines: 3,
          textDirection: Directionality.of(context),
        )..layout(maxWidth: constraints.maxWidth);
        final bool overflows = painter.didExceedMaxLines;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              widget.text,
              maxLines: _expanded ? null : 3,
              overflow:
                  _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
              style: widget.style,
            ),
            if (overflows || _expanded)
              GestureDetector(
                key: const Key('job_card_read_more'),
                behavior: HitTestBehavior.opaque,
                onTap: () => setState(() => _expanded = !_expanded),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Text(
                    _expanded ? 'Read less' : 'Read more',
                    style: AppTypography.body(
                      size: 12,
                      weight: FontWeight.w700,
                      color: JobCardPreview._infoText,
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _DutyChip extends StatelessWidget {
  const _DutyChip({
    required this.label,
    required this.icon,
    required this.bg,
  });

  final String label;
  final IconData icon;
  final Color bg;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(AppRadii.md),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 14, color: const Color(0xFF475069)),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                size: 12,
                weight: FontWeight.w600,
                color: const Color(0xFF101828),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
