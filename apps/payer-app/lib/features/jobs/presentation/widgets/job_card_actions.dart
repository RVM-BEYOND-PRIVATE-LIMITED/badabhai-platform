import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_haptics.dart';
import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_card.dart';
import '../../../../core/widgets/bb_icon_button.dart';
import '../../../../core/widgets/bb_pressable.dart';
import '../../../../core/widgets/bb_toast.dart';

// ---------------------------------------------------------------------------
// The My-jobs card actions (#2594), shared by the company and agency cards:
// one main action plus a "⋯" sheet, a confirm before every Close, toasts that
// name what happened, and Undo after a Pause.
// ---------------------------------------------------------------------------

/// Accessible name of the "⋯" button; the job title follows it.
const String kJobMoreActionsLabel = 'More actions';

/// The Close confirmation (#2594). A closed job is final (owner ruling), so a
/// Close is never one tap.
const String kCloseJobTitle = 'Close this job?';
const String kCloseJobConfirmLabel = 'Close job';
const String kCloseJobCancelLabel = 'Rehne do';
const Key kCloseJobConfirmKey = Key('close_job_confirm');
const Key kCloseJobCancelKey = Key('close_job_cancel');

/// The body of the Close confirmation for [jobTitle].
String closeJobMessage(String jobTitle) =>
    "Workers won't be able to apply to $jobTitle, and a closed job can't be "
    'opened again.';

/// The action on the toast after a Pause; the caller wires it to a resume.
const String kJobUndoLabel = 'Undo';

/// How long the Undo toast stays up — long enough to reach the button.
const Duration kJobUndoWindow = Duration(seconds: 5);

/// The secondary actions a card keeps behind its "⋯" button. The CARD decides
/// which are legal for the posting's state; the sheet only lists them, and a
/// pick of [close] always goes through [showCloseJobConfirm].
enum JobMenuAction {
  pause('Pause', Icons.pause_rounded),
  edit('Edit details', Icons.edit_rounded),
  close(kCloseJobConfirmLabel, Icons.cancel_rounded);

  const JobMenuAction(this.label, this.icon);

  final String label;
  final IconData icon;
}

/// A lifecycle action as its toast names it — "Job paused", "Couldn't close"
/// — instead of a generic "Done" / "Not now". The message under the title
/// comes from the cubit (what changed, or the real reason it did not).
enum JobLifecycleAction {
  publish(done: 'Job published', failed: "Couldn't publish"),
  pause(done: 'Job paused', failed: "Couldn't pause"),
  resume(done: 'Job resumed', failed: "Couldn't resume"),
  close(done: 'Job closed', failed: "Couldn't close");

  const JobLifecycleAction({required this.done, required this.failed});

  /// Toast title when the server accepted the action.
  final String done;

  /// Toast title when it did not.
  final String failed;
}

/// The job card's surface: a [BbCard] that, once [dimmed] (a closed job),
/// fades to the kit's row dim and collapses to its shorter, action-less height
/// — both over [AppMotion.base] (220ms) on the exit curve. Under reduced
/// motion both snap: the fade runs at zero, and there is NO [AnimatedSize] at
/// all (a zero-length one re-dirties its own layout and asserts). The closed
/// job stays in the list; only its card settles.
class JobCardSurface extends StatelessWidget {
  const JobCardSurface({super.key, required this.dimmed, required this.child});

  /// The design system's dim for a filled / closed row.
  static const double dimOpacity = 0.62;

  final bool dimmed;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final bool reduced = AppMotion.reduced(context);
    return AnimatedOpacity(
      opacity: dimmed ? dimOpacity : 1,
      duration: reduced ? Duration.zero : AppMotion.base,
      curve: AppMotion.easeIn,
      child: BbCard(
        child: reduced
            ? child
            : AnimatedSize(
                duration: AppMotion.base,
                curve: AppMotion.easeIn,
                alignment: Alignment.topCenter,
                child: child,
              ),
      ),
    );
  }
}

/// One main action plus the "⋯" that opens the rest — the card's layout
/// instead of a stack of buttons. [showMore] false draws no "⋯" (nothing else
/// is legal). [moreBusy] (an action picked from the sheet is in flight) puts a
/// spinner in its slot; a null [onMore] disables it. Both slots keep their
/// size, so the card never jumps.
class JobCardActionRow extends StatelessWidget {
  const JobCardActionRow({
    super.key,
    required this.main,
    required this.jobTitle,
    required this.onMore,
    this.showMore = true,
    this.moreBusy = false,
  });

  final Widget main;
  final String jobTitle;
  final VoidCallback? onMore;
  final bool showMore;
  final bool moreBusy;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(child: main),
        if (showMore) ...<Widget>[
          const SizedBox(width: AppSpacing.s2),
          if (moreBusy)
            const _MoreBusy()
          else
            BbIconButton(
              icon: Icons.more_horiz_rounded,
              semanticLabel: '$kJobMoreActionsLabel: $jobTitle',
              onPressed: onMore,
            ),
        ],
      ],
    );
  }
}

/// The "⋯" slot while its action runs: the same 48px square, a deep-blue
/// spinner (a progress indicator — the one thing allowed to loop).
class _MoreBusy extends StatelessWidget {
  const _MoreBusy();

  @override
  Widget build(BuildContext context) {
    return const SizedBox(
      width: AppSpacing.tap,
      height: AppSpacing.tap,
      child: Center(
        child: SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: AppColors.blue,
          ),
        ),
      ),
    );
  }
}

const ShapeBorder _kSheetShape = RoundedRectangleBorder(
  borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadii.xxl)),
);

/// Opens the "⋯" sheet for [jobTitle] with [actions] — slides up over
/// [AppMotion.sheet] (280ms), zero under reduced motion. Resolves to the
/// picked action, or null when dismissed.
Future<JobMenuAction?> showJobActionSheet(
  BuildContext context, {
  required String jobTitle,
  required List<JobMenuAction> actions,
}) {
  return showModalBottomSheet<JobMenuAction>(
    context: context,
    sheetAnimationStyle: AppMotion.sheetStyle(context),
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: AppColors.surfaceCard,
    shape: _kSheetShape,
    builder: (BuildContext sheetContext) => Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        0,
        AppSpacing.gutter,
        AppSpacing.s4,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            jobTitle,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.heading(size: AppTypography.sizeMd),
          ),
          const SizedBox(height: AppSpacing.s2),
          for (final JobMenuAction action in actions)
            _SheetRow(
              action: action,
              onTap: () => Navigator.of(sheetContext).pop(action),
            ),
        ],
      ),
    ),
  );
}

/// One 48px+ row of the "⋯" sheet: a solid deep-blue icon and the label, with
/// the shared press + light haptic.
class _SheetRow extends StatelessWidget {
  const _SheetRow({required this.action, required this.onTap});

  final JobMenuAction action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      child: BbPressable(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: AppSpacing.tap),
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.s2,
              vertical: AppSpacing.s3,
            ),
            child: Row(
              children: <Widget>[
                Icon(action.icon, size: 22, color: AppColors.blue),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: Text(
                    action.label,
                    style: AppTypography.body(weight: FontWeight.w600),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Asks before a Close — a bottom sheet over [AppMotion.sheet] (280ms), zero
/// under reduced motion. True ONLY on the explicit confirm; cancel, a tap on
/// the scrim and a drag-down all keep the job. Sized to its content (a long
/// job title wraps) and scrolls rather than overflow a small screen.
Future<bool> showCloseJobConfirm(
  BuildContext context, {
  required String jobTitle,
}) async {
  final bool? confirmed = await showModalBottomSheet<bool>(
    context: context,
    sheetAnimationStyle: AppMotion.sheetStyle(context),
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    backgroundColor: AppColors.surfaceCard,
    shape: _kSheetShape,
    builder: (BuildContext sheetContext) => SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        0,
        AppSpacing.gutter,
        AppSpacing.s5,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            kCloseJobTitle,
            style: AppTypography.heading(size: AppTypography.sizeLg),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            closeJobMessage(jobTitle),
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
          const SizedBox(height: AppSpacing.s6),
          Row(
            children: <Widget>[
              Expanded(
                child: BbButton(
                  label: kCloseJobCancelLabel,
                  variant: BbButtonVariant.secondary,
                  size: BbButtonSize.md,
                  buttonKey: kCloseJobCancelKey,
                  onPressed: () => Navigator.of(sheetContext).pop(false),
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbButton(
                  label: kCloseJobConfirmLabel,
                  // Deep-blue commitment (brand only); the sheet's title and
                  // copy carry the warning.
                  variant: BbButtonVariant.navy,
                  size: BbButtonSize.md,
                  buttonKey: kCloseJobConfirmKey,
                  onPressed: () {
                    // #2591 — medium haptic on a confirmed choice.
                    AppHaptics.confirm();
                    Navigator.of(sheetContext).pop(true);
                  },
                ),
              ),
            ],
          ),
        ],
      ),
    ),
  );
  return confirmed ?? false;
}

/// Shows a lifecycle outcome as the app's toast, titled for [action].
void showJobActionToast(
  BuildContext context,
  JobLifecycleAction action, {
  required bool success,
  required String message,
}) {
  showBbToast(
    context,
    title: success ? action.done : action.failed,
    message: message,
    icon: success ? Icons.check_circle_rounded : Icons.info_rounded,
  );
}

/// The toast after a successful Pause: names the outcome and offers
/// [kJobUndoLabel] for [kJobUndoWindow]; the caller wires [onUndo] to a
/// resume. The theme's flat deep-blue snack bar with the haldi action, so an
/// Undo stays reachable under TalkBack. Its content rises into place
/// ([JobToastRise]).
void showJobUndoToast(
  BuildContext context, {
  required String title,
  required String message,
  required VoidCallback onUndo,
}) {
  final Duration rise = AppMotion.resolve(context, AppMotion.base);
  ScaffoldMessenger.of(context)
    ..clearSnackBars()
    ..showSnackBar(
      SnackBar(
        duration: kJobUndoWindow,
        margin: const EdgeInsets.fromLTRB(
          AppSpacing.s4,
          0,
          AppSpacing.s4,
          AppSpacing.s5,
        ),
        content: JobToastRise(
          duration: rise,
          child: Row(
            children: <Widget>[
              const Icon(
                Icons.check_circle_rounded,
                color: AppColors.green300,
                size: 24,
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(
                      title,
                      style: AppTypography.body(
                        weight: FontWeight.w700,
                        color: AppColors.paper1,
                      ),
                    ),
                    Text(
                      message,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.ink200,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        action: SnackBarAction(label: kJobUndoLabel, onPressed: onUndo),
      ),
    );
}

/// The Undo toast's "slide up": its content rises [distance] px into place
/// while it fades in — transform + opacity only, ease-out, over [duration]
/// (pass it through [AppMotion.resolve] so reduced motion makes it instant).
class JobToastRise extends StatelessWidget {
  const JobToastRise({super.key, required this.duration, required this.child});

  /// Travel of the rise — the motion rules' 6px cap.
  static const double distance = 6;

  final Duration duration;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: duration,
      curve: AppMotion.easeOut,
      builder: (BuildContext context, double t, Widget? child) => Opacity(
        opacity: t,
        child: Transform.translate(
          offset: Offset(0, (1 - t) * distance),
          child: child,
        ),
      ),
      child: child,
    );
  }
}
