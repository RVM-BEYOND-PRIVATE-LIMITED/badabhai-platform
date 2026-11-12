import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../profile_edit/domain/profile_edit_repository.dart';
import '../../domain/availability_prompt_gate.dart';

enum AvailabilityPromptStatus { choosing, saving, saved }

class AvailabilityPromptState extends Equatable {
  const AvailabilityPromptState({
    this.status = AvailabilityPromptStatus.choosing,
    this.selected,
    this.failure,
  });

  final AvailabilityPromptStatus status;

  /// The picked `availability.status` slug, or null before a pick.
  final String? selected;

  /// Why the last save failed. The sheet stays open and shows it; a new pick
  /// or a retry clears it.
  final Failure? failure;

  bool get isSaving => status == AvailabilityPromptStatus.saving;

  /// "Save" is live once a choice is picked and nothing is in flight.
  bool get canSave =>
      status == AvailabilityPromptStatus.choosing && selected != null;

  @override
  List<Object?> get props => <Object?>[status, selected, failure];
}

/// The availability prompt's one decision: which of the served choices the
/// worker picks, saved with a single `PUT /workers/me/work-preferences`.
///
/// "Abhi nahi" needs nothing from here — the sheet just closes, and the gate
/// has already used up this launch's check.
class AvailabilityPromptCubit extends Cubit<AvailabilityPromptState> {
  AvailabilityPromptCubit({
    required ProfileEditRepository repository,
    required this.prompt,
  }) : _repository = repository,
       super(const AvailabilityPromptState());

  final ProfileEditRepository _repository;

  /// The choices and the stored availability this prompt was opened with.
  final AvailabilityPrompt prompt;

  /// Picks [slug]. Only a served choice can be picked, so only a slug the
  /// server's enum accepts can ever be sent.
  void select(String slug) {
    if (state.status != AvailabilityPromptStatus.choosing) return;
    if (!prompt.options.containsKey(slug)) return;
    emit(AvailabilityPromptState(selected: slug));
  }

  Future<void> save() async {
    final String? slug = state.selected;
    if (!state.canSave || slug == null) return;
    emit(
      AvailabilityPromptState(
        status: AvailabilityPromptStatus.saving,
        selected: slug,
      ),
    );
    try {
      await _repository.saveWorkPreferences(
        availabilityPromptBody(slug, stored: prompt.stored),
      );
      if (isClosed) return;
      emit(
        AvailabilityPromptState(
          status: AvailabilityPromptStatus.saved,
          selected: slug,
        ),
      );
    } on Failure catch (f) {
      if (isClosed) return;
      emit(AvailabilityPromptState(selected: slug, failure: f));
    } catch (_) {
      if (isClosed) return;
      emit(
        AvailabilityPromptState(
          selected: slug,
          failure: const UnknownFailure(),
        ),
      );
    }
  }
}
