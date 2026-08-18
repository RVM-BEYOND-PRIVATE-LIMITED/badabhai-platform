import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A single chat message bubble for the "bada bhai" profiling chat.
///
/// Worker messages sit right on the soft blue outgoing tint (the worker's own
/// voice, JUL31 "Josh" system); bada bhai sits left on crisp white with a
/// hairline. One corner is squared toward the speaker so the thread reads
/// naturally. Green stays reserved for money/success, so it is off the bubbles.
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
    this.trailing,
  });

  final String text;
  final bool fromWorker;

  /// An optional control rendered just to the RIGHT of the bubble (e.g. the
  /// read-aloud speaker on bada bhai's questions). Null on most bubbles.
  final Widget? trailing;

  /// The message did not reach the server. Renders a warning tint + a
  /// tap-to-retry footer instead of looking delivered.
  final bool failed;

  /// Tapped on a [failed] bubble to re-send it.
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    // Bubble radius 12 with ONE flattened 3px "tail" corner toward the speaker
    // (kit `rBubble` / `rBubbleTail`): bottom-right tail on the worker's own
    // messages, bottom-left tail on bada bhai's.
    const Radius soft = Radius.circular(AppRadii.md);
    const Radius tail = Radius.circular(AppRadii.bubbleTail);

    final Color background = failed
        ? AppColors.red50
        : (fromWorker ? AppColors.blueTintChat : AppColors.surfaceCard);
    // Outgoing bubble is borderless in the Josh system, so its border matches the
    // fill; incoming keeps the hairline; a failed send stays crimson-outlined.
    final Color borderColor = failed
        ? AppColors.red600
        : (fromWorker ? AppColors.blueTintChat : AppColors.borderSubtle);

    final Widget bubble = Container(
      // Bubbles never span the full column — cap at ~78% so the speaker side is
      // always legible (kit ChatBubble).
      constraints: BoxConstraints(
        maxWidth: MediaQuery.of(context).size.width * 0.78,
      ),
      margin: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
      // Snug, dense padding keeps more of the transcript on screen with the
      // keyboard open.
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s3,
        vertical: AppSpacing.s2,
      ),
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.only(
          topLeft: soft,
          topRight: soft,
          bottomLeft: fromWorker ? soft : tail,
          bottomRight: fromWorker ? tail : soft,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            text,
            // sizeSm (14) — a compact chat body (owner request 2026-07-23): the
            // profiling chat runs long and, with the keyboard open, larger text
            // left too little of the transcript + question visible. Still an
            // easily-legible size; the composer/CTA below keep their tap targets.
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textPrimary,
            ),
          ),
          if (failed) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(
                  Icons.error_outline,
                  size: 16,
                  color: AppColors.red600,
                ),
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

    // A failed bubble is the retry control itself — the whole bubble is the
    // tap target, so it comfortably clears the 48px minimum.
    final Widget content = failed && onRetry != null
        ? Semantics(
            button: true,
            label: '$text — $kChatSendFailedLabel',
            child: InkWell(
              onTap: onRetry,
              borderRadius: BorderRadius.circular(AppRadii.lg),
              child: bubble,
            ),
          )
        : bubble;

    return Align(
      alignment: fromWorker ? Alignment.centerRight : Alignment.centerLeft,
      child: trailing == null
          ? content
          : Row(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.center,
              children: <Widget>[
                Flexible(child: content),
                trailing!,
              ],
            ),
    );
  }
}
