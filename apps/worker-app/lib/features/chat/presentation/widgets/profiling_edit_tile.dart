import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart' show ProfilingEditProposal, ProfilingEditRow;
import '../../../../core/theme/onboarding_theme.dart';

/// Stable finders for tests.
const Key kProfilingEditTileKey = Key('profiling_edit_tile');
const Key kProfilingEditYesKey = Key('profiling_edit_yes');
const Key kProfilingEditNoKey = Key('profiling_edit_no');

/// ADR-0057 R10 (#2314) — the profiling chat's confirmation before it changes
/// or deletes an earlier answer, drawn as a tile in place of the Haan / Nahi
/// chips.
///
/// Each row: the field, the old value struck through, and the new one. A
/// delete shows the old value struck through and its warning, in the warning
/// colours. [onYes] / [onNo] send the turn's OWN Haan / Nahi chips, so the
/// server sees exactly what the text version sends.
class ProfilingEditTile extends StatelessWidget {
  const ProfilingEditTile({
    super.key,
    required this.proposal,
    required this.yesLabel,
    required this.noLabel,
    required this.onYes,
    required this.onNo,
    this.enabled = true,
  });

  final ProfilingEditProposal proposal;
  final String yesLabel;
  final String noLabel;
  final VoidCallback onYes;
  final VoidCallback onNo;

  /// False while the answer is on its way, so a double tap sends once.
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: kProfilingEditTileKey,
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: OnboardingColors.canvasIvory,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < proposal.rows.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 10),
            _EditRow(row: proposal.rows[i]),
          ],
          const SizedBox(height: 14),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton(
                  key: kProfilingEditNoKey,
                  onPressed: enabled ? onNo : null,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: OnboardingColors.shiftBlue,
                    side: const BorderSide(
                      color: OnboardingColors.shiftBlue,
                      width: 1.5,
                    ),
                    minimumSize: const Size.fromHeight(48),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: Text(
                    noLabel,
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  key: kProfilingEditYesKey,
                  onPressed: enabled ? onYes : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: OnboardingColors.safetyYellow,
                    foregroundColor: OnboardingColors.shiftBlue,
                    disabledBackgroundColor: OnboardingColors.disabledBg,
                    minimumSize: const Size.fromHeight(48),
                    elevation: 0,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: Text(
                    yesLabel,
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _EditRow extends StatelessWidget {
  const _EditRow({required this.row});

  final ProfilingEditRow row;

  @override
  Widget build(BuildContext context) {
    const TextStyle label = TextStyle(
      color: OnboardingColors.shiftBlue,
      fontSize: 13,
      fontWeight: FontWeight.w700,
    );
    final TextStyle struck = TextStyle(
      color: OnboardingColors.shiftBlue.withValues(alpha: 0.6),
      fontSize: 15,
      decoration: TextDecoration.lineThrough,
      decorationColor: OnboardingColors.shiftBlue.withValues(alpha: 0.6),
    );
    const TextStyle fresh = TextStyle(
      color: OnboardingColors.shiftBlue,
      fontSize: 15,
      fontWeight: FontWeight.w800,
    );
    final String? before = row.before;
    final String? warning = row.warning;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(row.fieldLabel, style: label),
        const SizedBox(height: 4),
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 8,
          runSpacing: 4,
          children: <Widget>[
            if (before != null) Text(before, style: struck),
            if (!row.isDelete) ...<Widget>[
              Icon(
                Icons.arrow_forward_rounded,
                size: 18,
                color: OnboardingColors.shiftBlue,
                semanticLabel: 'se',
              ),
              Text(row.after!, style: fresh),
            ],
          ],
        ),
        if (row.isDelete && warning != null) ...<Widget>[
          const SizedBox(height: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: OnboardingColors.errorBg,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: <Widget>[
                const Icon(
                  Icons.warning_rounded,
                  size: 18,
                  color: OnboardingColors.errorRed,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    warning,
                    style: const TextStyle(
                      color: OnboardingColors.errorRed,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
