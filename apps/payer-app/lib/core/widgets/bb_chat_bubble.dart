import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Copy on an undelivered payer bubble. States the honest cause and the action
/// — never a vague "something went wrong".
const String kPayerChatSendFailedLabel = 'Not sent — tap to send again';

/// A single chat message bubble, the payer-app twin of the worker app's
/// `BbChatBubble` (`apps/worker-app/lib/core/widgets/bb_chat_bubble.dart`).
///
/// The payer's own messages sit right on a soft green tint (their voice); the
/// assistant sits left on crisp white with a warm hairline. One corner is
/// squared toward the speaker so the thread reads naturally. Colours come from
/// the theme tokens only — nothing here is a literal.
class BbChatBubble extends StatelessWidget {
  const BbChatBubble({
    super.key,
    required this.text,
    required this.fromPayer,
    this.failed = false,
    this.onRetry,
  });

  final String text;
  final bool fromPayer;

  /// The message did not reach the server. Renders a danger tint + a
  /// tap-to-retry footer instead of looking delivered — a payer whose answer
  /// never landed must find out here, not when the draft comes out empty.
  final bool failed;

  /// Tapped on a [failed] bubble to re-send it.
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    const Radius soft = Radius.circular(AppRadii.lg);
    const Radius tight = Radius.circular(AppRadii.xs);

    final Color background = failed
        ? AppColors.dangerTint
        : (fromPayer ? AppColors.green50 : AppColors.surfaceCard);
    final Color borderColor = failed
        ? AppColors.dangerPress
        : (fromPayer ? AppColors.green100 : AppColors.borderSubtle);

    final Widget bubble = Container(
      constraints: const BoxConstraints(maxWidth: 300),
      margin: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s2,
      ),
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.only(
          topLeft: soft,
          topRight: soft,
          bottomLeft: fromPayer ? soft : tight,
          bottomRight: fromPayer ? tight : soft,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            text,
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
                  color: AppColors.dangerPress,
                ),
                const SizedBox(width: AppSpacing.s1),
                Flexible(
                  child: Text(
                    kPayerChatSendFailedLabel,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      weight: FontWeight.w700,
                      color: AppColors.dangerPress,
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
      alignment: fromPayer ? Alignment.centerRight : Alignment.centerLeft,
      // A failed bubble IS the retry control — the whole bubble is the tap
      // target, so it comfortably clears the 48px minimum.
      child: failed && onRetry != null
          ? Semantics(
              button: true,
              label: '$text — $kPayerChatSendFailedLabel',
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
