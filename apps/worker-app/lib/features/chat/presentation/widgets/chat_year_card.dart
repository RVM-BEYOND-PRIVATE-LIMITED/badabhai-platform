import 'package:flutter/material.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/bb_bottom_sheet.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/onboarding/primary_action_button.dart';
import '../../domain/chat_year_questions.dart';

/// The inline affordance for a calendar-year question (`date_issue.jpeg`).
const String kChatYearPickLabel = 'Saal chunein';

/// The sheet's own title.
const String kChatYearSheetTitle = 'Kis saal?';

/// The composer hint shown INSTEAD of the keyboard on a year turn: the picker
/// is the only answer path, exactly as the location dialog is for `worker_state`
/// / `worker_city`.
const String kChatYearComposerHint = 'Neeche se saal chunein';

/// Test/automation handle for the button that opens the sheet.
const Key kChatYearPickCtaKey = ValueKey<String>('chat-year-pick');

/// Asks the worker which year, from a list that CANNOT contain a wrong one.
///
/// Newest first and nothing after today, so "2050" is not refused — it is not
/// offered. Returns the chosen year, or null when the sheet is dismissed (the
/// question then simply stands, as an unanswered question does).
Future<int?> showChatYearSheet(
  BuildContext context, {
  DateTime Function() clock = DateTime.now,
}) {
  final List<int> years = chatYearOptions(now: clock());
  return showBbBottomSheet<int>(
    context: context,
    maxWidth: OnboardingLayout.maxContentWidth,
    builder: (BuildContext sheetContext) => Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s2,
        AppSpacing.s4,
        AppSpacing.s4,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            kChatYearSheetTitle,
            style: OnboardingTypography.anek(size: 18),
          ),
          const SizedBox(height: AppSpacing.s3),
          // The years do not fit a short screen, so the LIST scrolls inside the
          // sheet rather than the sheet overflowing.
          Flexible(
            child: SingleChildScrollView(
              child: Wrap(
                spacing: AppSpacing.s2,
                runSpacing: AppSpacing.s2,
                children: <Widget>[
                  for (final int y in years)
                    BbChip(
                      label: '$y',
                      onTap: () => Navigator.of(sheetContext).pop(y),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

/// The card drawn in place of chips on a year turn: one button that opens
/// [showChatYearSheet].
///
/// A BUTTON rather than 70-odd inline chips, which would bury the transcript
/// and make the oldest years an unreachable scroll on a small phone.
class ChatYearCard extends StatelessWidget {
  const ChatYearCard({
    super.key,
    required this.onPicked,
    this.clock = DateTime.now,
  });

  /// Called with the chosen year. Never called on a dismissed sheet.
  final void Function(int year) onPicked;

  /// Injected only so a test need not depend on the wall clock.
  final DateTime Function() clock;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: PrimaryActionButton(
        buttonKey: kChatYearPickCtaKey,
        label: kChatYearPickLabel,
        showArrow: false,
        onPressed: () async {
          final int? picked = await showChatYearSheet(context, clock: clock);
          if (picked != null) onPicked(picked);
        },
      ),
    );
  }
}
