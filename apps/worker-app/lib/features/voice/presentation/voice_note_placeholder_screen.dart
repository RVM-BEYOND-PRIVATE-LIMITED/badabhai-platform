import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';

/// Voice note capture — PLACEHOLDER. Real recording + upload (≤120s) and Sarvam
/// STT come later. This screen just illustrates the entry point in the flow.
class VoiceNotePlaceholderScreen extends StatelessWidget {
  const VoiceNotePlaceholderScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Voice note'),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Container(
              width: 96,
              height: 96,
              decoration: const BoxDecoration(
                color: AppColors.saffron50,
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.mic_rounded,
                  size: 48, color: AppColors.saffronDeep),
            ),
            const SizedBox(height: AppSpacing.s5),
            Text(
              'Voice notes (max 120s) are a Phase 1 placeholder. Recording, '
              'upload, and transcription will be added later.',
              textAlign: TextAlign.center,
              style: AppTypography.body(
                size: AppTypography.sizeMd,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s7),
            BbButton(
              label: 'Back to chat',
              variant: BbButtonVariant.secondary,
              iconLeft: Icons.arrow_back_rounded,
              onPressed: () => Navigator.pop(context),
            ),
          ],
        ),
      ),
    );
  }
}
