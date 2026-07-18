import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A single chat message bubble for the "bada bhai" profiling chat.
///
/// Worker messages sit right on a soft green tint (the worker's own voice);
/// bada bhai sits left on crisp white with a warm hairline. One corner is
/// squared toward the speaker so the thread reads naturally.
/// Hinglish copy on an undelivered worker bubble (#343). States the honest
/// cause and the action — never a vague "kuch gadbad".
const String kChatSendFailedLabel = 'Nahi bheja gaya — dobara bhejein';

class BbChatBubble extends StatelessWidget {
  const BbChatBubble({
    super.key,
    required this.text,
    required this.fromWorker,
    this.failed = false,
    this.onRetry,
  });

  final String text;
  final bool fromWorker;

  /// The message did not reach the server. Renders a warning tint + a
  /// tap-to-retry footer instead of looking delivered.
  final bool failed;

  /// Tapped on a [failed] bubble to re-send it.
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    const Radius soft = Radius.circular(AppRadii.lg);
    const Radius tight = Radius.circular(AppRadii.xs);

    final Color background = failed
        ? AppColors.red50
        : (fromWorker ? AppColors.green50 : AppColors.surfaceCard);
    final Color borderColor = failed
        ? AppColors.red600
        : (fromWorker ? AppColors.green100 : AppColors.borderSubtle);

    final Widget bubble = Container(
      constraints: const BoxConstraints(maxWidth: 300),
      margin: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.only(
          topLeft: soft,
          topRight: soft,
          bottomLeft: fromWorker ? soft : tight,
          bottomRight: fromWorker ? tight : soft,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            text,
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textPrimary,
            ),
          ),
          if (failed) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(Icons.error_outline,
                    size: 16, color: AppColors.red600),
                const SizedBox(width: AppSpacing.s1),
                Flexible(
                  child: Text(
                    kChatSendFailedLabel,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      weight: FontWeight.w700,
                      color: AppColors.red600,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );

    return Align(
      alignment: fromWorker ? Alignment.centerRight : Alignment.centerLeft,
      // A failed bubble is the retry control itself — the whole bubble is the
      // tap target, so it comfortably clears the 48px minimum.
      child: failed && onRetry != null
          ? Semantics(
              button: true,
              label: '$text — $kChatSendFailedLabel',
              child: InkWell(
                onTap: onRetry,
                borderRadius: BorderRadius.circular(AppRadii.lg),
                child: bubble,
              ),
            )
          : bubble,
    );
  }
}
