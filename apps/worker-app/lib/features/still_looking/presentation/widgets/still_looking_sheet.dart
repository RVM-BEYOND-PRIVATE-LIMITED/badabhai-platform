import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure_reason.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/bb_palette.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/bb_bottom_sheet.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/kit/kit_select_chip.dart';
import '../../../consent/presentation/widgets/consent_notice_parts.dart'
    show ConsentErrorLine;
import '../../domain/still_looking_repository.dart';
import '../cubit/still_looking_cubit.dart';

/// The monthly check's question (#2753 item 5).
const String kStillLookingTitle = 'Abhi bhi kaam dhoondh rahe hain?';

/// Why it is asked — once a month, so companies see an honest answer.
const String kStillLookingSubtitle =
    'Mahine mein ek baar hum poochte hain, taaki companies ko sahi jaankari '
    'mile.';

/// The optional availability re-ask header (only when the server asks for it).
const String kStillLookingAvailabilityTitle = 'Availability update karein';

/// The three answers, as the server's strict enum names them.
const String kStillLookingYesLabel = 'Haan, dhoondh raha hoon';
const String kStillLookingNotNowLabel = 'Abhi nahi';
const String kStillLookingHiredLabel = 'Job mil gayi';

/// The consequence of "not now", stated plainly on the card.
const String kStillLookingNotNowNote =
    "'Abhi nahi' chunne par aap company search se hat jayenge. Apply karna "
    'band nahi hoga.';

/// The confirmation after the server accepted the answer.
const String kStillLookingSavedMessage = 'Dhanyavaad — jawab save ho gaya.';

/// Test handles.
const Key kStillLookingYesKey = ValueKey<String>('still-looking-yes');
const Key kStillLookingNotNowKey = ValueKey<String>('still-looking-not-now');
const Key kStillLookingHiredKey = ValueKey<String>('still-looking-hired');

/// Opens the monthly card over [context] (#2753 item 5).
///
/// Resolves `true` once the server accepted an answer. Resolves `false` when
/// the worker closes it without answering — the check stays due, so the card
/// is offered again on the next app open.
///
/// While a save is in flight none of the close paths work: the sheet waits for
/// the server's answer, then closes on success or stays open with the reason
/// on failure. A `POST` never lands behind a card the worker already closed.
Future<bool> showStillLookingSheet(
  BuildContext context, {
  required StillLookingCubit cubit,
}) async {
  final ValueNotifier<bool> dismissible = ValueNotifier<bool>(true);
  final StreamSubscription<StillLookingState> holdWhileSaving = cubit.stream
      .listen((StillLookingState s) => dismissible.value = !s.saving);
  final bool answered;
  try {
    answered =
        await showBbBottomSheet<bool>(
          context: context,
          dismissible: dismissible,
          builder: (_) => BlocProvider<StillLookingCubit>.value(
            value: cubit,
            child: const StillLookingSheetBody(),
          ),
          footer: (_) => BlocProvider<StillLookingCubit>.value(
            value: cubit,
            child: const StillLookingSheetActions(),
          ),
        ) ??
        false;
  } finally {
    unawaited(holdWhileSaving.cancel());
    dismissible.dispose();
  }
  if (answered && context.mounted) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(const SnackBar(content: Text(kStillLookingSavedMessage)));
  }
  return answered;
}

/// The question, the optional availability chips and the failure line. Scrolls
/// inside the sheet's height cap, so a small phone at a large system font
/// never pushes the answers under the docked actions.
class StillLookingSheetBody extends StatelessWidget {
  const StillLookingSheetBody({super.key});

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final StillLookingCubit cubit = context.read<StillLookingCubit>();
    return BlocBuilder<StillLookingCubit, StillLookingState>(
      builder: (BuildContext context, StillLookingState state) {
        return SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                kStillLookingTitle,
                style: OnboardingTypography.questionHeadline(
                  color: p.textBrand,
                ),
              ),
              const SizedBox(height: AppSpacing.s1),
              Text(
                kStillLookingSubtitle,
                style: OnboardingTypography.bodyMuted(),
              ),
              if (state.showAvailabilityAsk) ...<Widget>[
                const SizedBox(height: AppSpacing.s4),
                Text(
                  kStillLookingAvailabilityTitle,
                  style: OnboardingTypography.cardTitle(),
                ),
                const SizedBox(height: AppSpacing.s2),
                Wrap(
                  spacing: AppSpacing.s2,
                  runSpacing: AppSpacing.s2,
                  children: <Widget>[
                    for (final MapEntry<String, String> option
                        in state.availabilityOptions.entries)
                      KitSelectChip(
                        label: option.value,
                        selected: state.selectedAvailability == option.key,
                        onTap: state.saving
                            ? null
                            : () => cubit.selectAvailability(option.key),
                      ),
                  ],
                ),
              ],
              const SizedBox(height: AppSpacing.s3),
              Text(
                kStillLookingNotNowNote,
                style: OnboardingTypography.bodyMuted(),
              ),
              if (state.failure != null) ...<Widget>[
                const SizedBox(height: AppSpacing.s3),
                ConsentErrorLine(failureReason(state.failure).reason),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// The docked answers: "yes" (primary), "not now" (outline) and "hired"
/// (ghost). Closes the sheet with `true` when the server accepts the answer.
class StillLookingSheetActions extends StatelessWidget {
  const StillLookingSheetActions({super.key});

  @override
  Widget build(BuildContext context) {
    final StillLookingCubit cubit = context.read<StillLookingCubit>();
    return BlocConsumer<StillLookingCubit, StillLookingState>(
      listenWhen: (StillLookingState prev, StillLookingState curr) =>
          !prev.answered && curr.answered,
      listener: (BuildContext context, StillLookingState _) =>
          Navigator.of(context).pop(true),
      builder: (BuildContext context, StillLookingState state) {
        final bool disabled = !state.canAnswer;
        return Padding(
          padding: const EdgeInsets.only(top: AppSpacing.s4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              BbButton(
                buttonKey: kStillLookingYesKey,
                label: kStillLookingYesLabel,
                size: BbButtonSize.md,
                block: true,
                loading: state.saving,
                onPressed: disabled
                    ? null
                    : () => cubit.answer(StillLookingAnswer.yes),
              ),
              const SizedBox(height: AppSpacing.s2),
              BbButton(
                buttonKey: kStillLookingNotNowKey,
                label: kStillLookingNotNowLabel,
                variant: BbButtonVariant.outline,
                size: BbButtonSize.md,
                block: true,
                onPressed: disabled
                    ? null
                    : () => cubit.answer(StillLookingAnswer.notNow),
              ),
              const SizedBox(height: AppSpacing.s2),
              BbButton(
                buttonKey: kStillLookingHiredKey,
                label: kStillLookingHiredLabel,
                variant: BbButtonVariant.ghost,
                size: BbButtonSize.md,
                block: true,
                onPressed: disabled
                    ? null
                    : () => cubit.answer(StillLookingAnswer.hired),
              ),
            ],
          ),
        );
      },
    );
  }
}
