import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/kit/kit_select_chip.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../consent/presentation/widgets/consent_notice_parts.dart'
    show ConsentErrorLine;
import '../../profile_edit/domain/profile_edit_repository.dart';
import '../domain/availability_prompt_gate.dart';
import 'cubit/availability_prompt_cubit.dart';

/// The sheet's question — the same words the trade form asks it with.
const String kAvailabilityPromptTitle = 'Kab se available hain?';

/// Why it is asked: the only case the shell asks is an empty answer.
const String kAvailabilityPromptSubtitle =
    'Aapki profile mein yeh jaankari abhi khaali hai. '
    'Jo sahi ho, woh chunein.';

const String kAvailabilityPromptSaveLabel = 'Save karein';

const String kAvailabilityPromptNotNowLabel = 'Abhi nahi';

/// The confirmation after the server accepted the answer.
const String kAvailabilityPromptSavedMessage = 'Availability save ho gayi.';

/// Test handle for the save CTA.
const Key kAvailabilityPromptSaveKey = ValueKey<String>(
  'availability-prompt-save',
);

/// Opens the availability prompt over [context] (#2748 item 1d).
///
/// Resolves `true` once the server accepted the answer, and then confirms it
/// with a snackbar. Resolves `false` for "Abhi nahi", a swipe down, a tap on
/// the scrim or system back — each of them a "not now", which writes nothing
/// to the server (the caller decides whether to remember it).
///
/// [repository] is a seam for tests; the app passes none and gets the shared
/// [ProfileEditRepository].
Future<bool> showAvailabilityPromptSheet(
  BuildContext context, {
  required AvailabilityPrompt prompt,
  ProfileEditRepository? repository,
}) async {
  final AvailabilityPromptCubit cubit = AvailabilityPromptCubit(
    repository: repository ?? locator<ProfileEditRepository>(),
    prompt: prompt,
  );
  final bool saved;
  try {
    saved =
        await showBbBottomSheet<bool>(
          context: context,
          builder: (_) => BlocProvider<AvailabilityPromptCubit>.value(
            value: cubit,
            child: const AvailabilityPromptBody(),
          ),
          footer: (_) => BlocProvider<AvailabilityPromptCubit>.value(
            value: cubit,
            child: const AvailabilityPromptActions(),
          ),
        ) ??
        false;
  } finally {
    await cubit.close();
  }
  if (saved && context.mounted) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        const SnackBar(content: Text(kAvailabilityPromptSavedMessage)),
      );
  }
  return saved;
}

/// The question and one chip per served choice. Scrolls inside the sheet's
/// height cap, so a small phone at a large system font never pushes the
/// choices under the docked actions.
class AvailabilityPromptBody extends StatelessWidget {
  const AvailabilityPromptBody({super.key});

  @override
  Widget build(BuildContext context) {
    final AvailabilityPromptCubit cubit = context
        .read<AvailabilityPromptCubit>();
    return BlocBuilder<AvailabilityPromptCubit, AvailabilityPromptState>(
      builder: (BuildContext context, AvailabilityPromptState state) {
        return SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                kAvailabilityPromptTitle,
                style: OnboardingTypography.questionHeadline(
                  color: OnboardingColors.shiftBlue,
                ),
              ),
              const SizedBox(height: AppSpacing.s1),
              Text(
                kAvailabilityPromptSubtitle,
                style: OnboardingTypography.bodyMuted(),
              ),
              const SizedBox(height: AppSpacing.s4),
              Wrap(
                spacing: AppSpacing.s2,
                runSpacing: AppSpacing.s2,
                children: <Widget>[
                  for (final MapEntry<String, String> option
                      in cubit.prompt.options.entries)
                    KitSelectChip(
                      label: option.value,
                      selected: state.selected == option.key,
                      onTap: state.isSaving
                          ? null
                          : () => cubit.select(option.key),
                    ),
                ],
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

/// The docked actions: save (live once a choice is picked) and "Abhi nahi".
/// Closes the sheet with `true` when the save lands.
class AvailabilityPromptActions extends StatelessWidget {
  const AvailabilityPromptActions({super.key});

  @override
  Widget build(BuildContext context) {
    final AvailabilityPromptCubit cubit = context
        .read<AvailabilityPromptCubit>();
    return BlocConsumer<AvailabilityPromptCubit, AvailabilityPromptState>(
      listenWhen:
          (AvailabilityPromptState prev, AvailabilityPromptState curr) =>
              prev.status != curr.status &&
              curr.status == AvailabilityPromptStatus.saved,
      listener: (BuildContext context, AvailabilityPromptState _) =>
          Navigator.of(context).pop(true),
      builder: (BuildContext context, AvailabilityPromptState state) {
        return Padding(
          padding: const EdgeInsets.only(top: AppSpacing.s4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              PrimaryActionButton(
                buttonKey: kAvailabilityPromptSaveKey,
                label: kAvailabilityPromptSaveLabel,
                showArrow: false,
                isLoading: state.isSaving,
                onPressed: state.canSave ? cubit.save : null,
              ),
              const SizedBox(height: AppSpacing.s2),
              BbButton(
                label: kAvailabilityPromptNotNowLabel,
                variant: BbButtonVariant.ghost,
                size: BbButtonSize.md,
                block: true,
                onPressed: state.isSaving
                    ? null
                    : () => Navigator.of(context).pop(false),
              ),
            ],
          ),
        );
      },
    );
  }
}
