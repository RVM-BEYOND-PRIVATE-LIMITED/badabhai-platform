import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../domain/clip_player.dart';
import '../domain/voice_review_row.dart';

// Persona-clean copy (scanned by persona_neutrality_test.dart).
const String _kTitle = 'Ek baar dekh lein';
const String _kSubmit = 'Sab theek hai';
const String _kDeclined = 'Nahi bataya';
const String _kSending = 'Bheja ja raha hai';
const String _kDeferSubmit = 'Baad mein bhejein';
const String _kReplayLabel = 'Apni awaaz sunein';
const String _kCorrectLabel = 'Theek karein';
const String _kCorrectSheetTitle = 'Kaise theek karein';
const String _kCorrectByChip = 'Chip se chunein';
const String _kCorrectByVoice = 'Dobara bolein';
const String _kCorrectByType = 'Type karke likhein';

/// How the worker chose to correct a row (#632). The offered order is fixed —
/// chips → mic → typing — because typing is the last resort for someone who may
/// not be able to type at all.
enum CorrectionMethod { chips, voice, typing }

/// The end-of-session review screen (#632) — the ONLY path to submit. Because
/// the cubit only enters `VoiceFormReview` after the engine is done and
/// `submitReviewed` is guarded to that state, submission is structurally
/// reachable only from here.
///
/// One row per question: a short field label, the captured normalized value
/// ("Nahi bataya" when declined), a ⟲ correction and a 🔊 that replays the
/// worker's OWN clip — never a synthesized read-back.
class VoiceReviewScreen extends StatelessWidget {
  const VoiceReviewScreen({
    super.key,
    required this.rows,
    required this.onSubmit,
    required this.onCorrect,
    this.clipPlayer = const SilentClipPlayer(),
    this.submitting = false,
    this.inFlightCount = 0,
    this.onDeferSubmit,
  }) : assert(
          inFlightCount == 0 || onDeferSubmit != null,
          'a draining queue disables the submit CTA, so an escape hatch is '
          'mandatory — without onDeferSubmit BOTH buttons are dead and a '
          'worker who just answered the whole interview on 2G has no way to '
          'submit at all (#637 retries for up to 24h)',
        );

  final List<VoiceReviewRow> rows;
  final VoidCallback onSubmit;

  /// The worker chose to correct the row with [questionId] via
  /// [CorrectionMethod].
  ///
  /// Addressed by the engine's stable question id, never the list position:
  /// the sheet is open across an await, and a rows refresh underneath it would
  /// otherwise re-target the correction at whatever now sits at that index.
  final void Function(String questionId, CorrectionMethod method) onCorrect;

  final ClipPlayer clipPlayer;
  final bool submitting;

  /// Clips still uploading (from the offline queue, #637). While > 0 the CTA is
  /// disabled and the worker may defer with [onDeferSubmit].
  final int inFlightCount;
  final VoidCallback? onDeferSubmit;

  bool get _draining => inFlightCount > 0;

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: _kTitle),
      bottomBar: _bottomBar(),
      body: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s4),
        itemCount: rows.length,
        separatorBuilder: (_, __) => const Divider(height: AppSpacing.s6),
        itemBuilder: (BuildContext context, int i) => _row(context, i, rows[i]),
      ),
    );
  }

  Widget _row(BuildContext context, int index, VoiceReviewRow row) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(row.fieldLabel,
                  style: AppTypography.body(
                      size: AppTypography.sizeXs,
                      color: AppColors.textMuted)),
              const SizedBox(height: AppSpacing.s1),
              if (row.declined)
                Text(_kDeclined,
                    style: AppTypography.body(
                        color: AppColors.textMuted,
                        weight: FontWeight.w500))
              else
                Text(
                  row.displayValue,
                  style: row.numeric
                      ? AppTypography.mono(size: 16)
                      : AppTypography.body(
                          size: 16, weight: FontWeight.w600),
                ),
            ],
          ),
        ),
        if (row.clipPath != null)
          IconButton(
            iconSize: 22,
            constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
            tooltip: _kReplayLabel,
            onPressed: () => clipPlayer.playFile(row.clipPath!),
            icon: const Icon(Icons.volume_up_outlined, color: AppColors.blue),
          ),
        IconButton(
          iconSize: 22,
          constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          tooltip: _kCorrectLabel,
          onPressed: () => _openCorrection(context, row),
          icon: const Icon(Icons.replay, color: AppColors.textSecondary),
        ),
      ],
    );
  }

  Future<void> _openCorrection(BuildContext context, VoiceReviewRow row) async {
    // `row` is captured BEFORE the await and its id used after, so the
    // correction lands on the question the worker actually tapped even if
    // `rows` is replaced while the sheet is open.
    final String questionId = row.questionId;
    final CorrectionMethod? method = await showModalBottomSheet<CorrectionMethod>(
      context: context,
      builder: (_) => VoiceCorrectionSheet(hasChoices: row.hasChoices),
    );
    if (method != null) onCorrect(questionId, method);
  }

  Widget _bottomBar() {
    if (_draining) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text('$_kSending…',
              style: AppTypography.body(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          Row(
            children: <Widget>[
              Expanded(
                child: BbButton(
                  label: _kSubmit,
                  onPressed: null, // disabled until the queue drains
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbButton(
                  label: _kDeferSubmit,
                  variant: BbButtonVariant.outline,
                  onPressed: onDeferSubmit,
                ),
              ),
            ],
          ),
        ],
      );
    }
    return BbButton(
      label: _kSubmit,
      block: true,
      loading: submitting,
      onPressed: submitting ? null : onSubmit,
    );
  }
}

/// The correction options for one row, in the fixed order chips → mic → typing
/// (#632). Chips appear only when the question offered options; typing is last
/// because it is the last resort for a worker who may not be able to type.
class VoiceCorrectionSheet extends StatelessWidget {
  const VoiceCorrectionSheet({super.key, required this.hasChoices});

  final bool hasChoices;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.all(AppSpacing.s4),
            child: Text(_kCorrectSheetTitle,
                style: AppTypography.display(size: 18)),
          ),
          if (hasChoices)
            _option(context, Icons.touch_app_outlined, _kCorrectByChip,
                CorrectionMethod.chips),
          _option(context, Icons.mic_none_outlined, _kCorrectByVoice,
              CorrectionMethod.voice),
          _option(context, Icons.keyboard_outlined, _kCorrectByType,
              CorrectionMethod.typing),
          const SizedBox(height: AppSpacing.s2),
        ],
      ),
    );
  }

  Widget _option(BuildContext context, IconData icon, String label,
      CorrectionMethod method) {
    return ListTile(
      leading: Icon(icon, color: AppColors.blue),
      title: Text(label, style: AppTypography.body(size: 16)),
      onTap: () => Navigator.of(context).pop(method),
    );
  }
}
