import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
import '../../../availability_prompt/domain/availability_prompt_gate.dart'
    show availabilityPromptBody, availabilityPromptOptions;
import '../../../profile_edit/domain/profile_edit_repository.dart';
import '../../domain/still_looking_repository.dart';

enum StillLookingStatus {
  loading,
  ready,

  /// `404` — `STILL_LOOKING_CHECK_ENABLED` is off, so nothing renders.
  hidden,

  /// `503` (or any other failure) — retryable; no broken control is drawn.
  failed,
}

class StillLookingState extends Equatable {
  const StillLookingState({
    this.status = StillLookingStatus.loading,
    this.dto,
    this.availabilityOptions = const <String, String>{},
    this.storedAvailability,
    this.selectedAvailability,
    this.saving = false,
    this.answered = false,
    this.failure,
  });

  final StillLookingStatus status;

  /// The server's last answer (GET, or the POST's reply).
  final StillLookingDto? dto;

  /// The SERVER-served `availability_status` dictionary (`slug → label`), in
  /// chip order, when the stored availability needs re-asking. Empty when the
  /// card has no availability ask.
  final Map<String, String> availabilityOptions;

  /// The stored availability object the re-ask must not erase (date, notice).
  final WorkAvailabilityDto? storedAvailability;

  /// The availability chip the worker picked, if any.
  final String? selectedAvailability;

  /// A write is in flight; the card holds its close actions.
  final bool saving;

  /// The POST landed; the sheet closes on this.
  final bool answered;

  /// Why the last write failed. The sheet stays open and shows it.
  final Failure? failure;

  bool get due => dto?.due == true;

  bool get notRecentlyActive => dto?.notRecentlyActive == true;

  /// True only when the server asked for an availability re-ask AND a usable
  /// chip list arrived. A failed options read degrades to the three answers
  /// rather than blocking the monthly check.
  bool get showAvailabilityAsk =>
      (dto?.availabilityNeedsAnswer ?? false) && availabilityOptions.isNotEmpty;

  bool get canAnswer => status == StillLookingStatus.ready && !saving;

  @override
  List<Object?> get props => <Object?>[
    status,
    dto,
    availabilityOptions,
    storedAvailability,
    selectedAvailability,
    saving,
    answered,
    failure,
  ];
}

/// The monthly "still looking?" check (#2753 item 5): reads the server's
/// state, offers the availability re-ask when the server asks for it, and
/// posts the one answer.
///
/// The card is shown only while [StillLookingState.due] is true. The same
/// cubit drives the "not recently active" banner, so an answer updates both
/// without a second read. A `404` (switch off) hides everything; a `503`
/// leaves it retryable.
class StillLookingCubit extends Cubit<StillLookingState> {
  StillLookingCubit({
    required StillLookingRepository repository,
    ProfileEditRepository? profileRepository,
  }) : _repository = repository,
       _profileRepository = profileRepository,
       super(const StillLookingState());

  final StillLookingRepository _repository;
  final ProfileEditRepository? _profileRepository;

  bool _loading = false;

  Future<void> load() async {
    if (_loading) return;
    // A refresh must never wipe a write in flight (the shell re-reads on
    // resume, which can land while the worker is answering the card).
    if (state.saving) return;
    _loading = true;
    emit(const StillLookingState());
    try {
      final StillLookingDto dto = await _repository.read();
      if (isClosed) return;

      Map<String, String> options = const <String, String>{};
      WorkAvailabilityDto? stored;
      if (dto.availabilityNeedsAnswer && _profileRepository != null) {
        // FAIL-SOFT: the monthly answer must never be blocked by the optional
        // availability re-ask, so a failed options/stored read simply drops
        // those chips and leaves the three answers usable.
        try {
          final WorkPrefOptionsDto served = await _profileRepository
              .loadWorkPreferenceOptions();
          final WorkPreferencesDto prefs = await _profileRepository
              .loadWorkPreferences();
          options = availabilityPromptOptions(served);
          stored = prefs.availability;
        } catch (_) {
          options = const <String, String>{};
          stored = null;
        }
      }
      if (isClosed) return;
      emit(
        StillLookingState(
          status: StillLookingStatus.ready,
          dto: dto,
          availabilityOptions: options,
          storedAvailability: stored,
        ),
      );
    } on Failure catch (f) {
      if (isClosed) return;
      emit(
        StillLookingState(
          status: _switchOff(f)
              ? StillLookingStatus.hidden
              : StillLookingStatus.failed,
          failure: _switchOff(f) ? null : f,
        ),
      );
    } finally {
      _loading = false;
    }
  }

  /// Picks a served availability chip. Only a slug the server offered can be
  /// picked, so only a slug the PUT's strict enum accepts can ever be sent.
  void selectAvailability(String slug) {
    if (!state.canAnswer) return;
    if (!state.availabilityOptions.containsKey(slug)) return;
    emit(
      StillLookingState(
        status: state.status,
        dto: state.dto,
        availabilityOptions: state.availabilityOptions,
        storedAvailability: state.storedAvailability,
        selectedAvailability: slug,
        saving: state.saving,
        answered: state.answered,
      ),
    );
  }

  /// Posts one answer. When an availability chip was picked, the SAME card
  /// first saves it with the profile editor's own `PUT`, preserving the stored
  /// date and notice days; a failed availability save keeps the card open and
  /// the answer is NOT sent (fail closed — the worker retries, nothing is
  /// half-applied).
  Future<void> answer(StillLookingAnswer answer) async {
    if (!state.canAnswer) return;
    final StillLookingDto? previous = state.dto;
    if (previous == null) return;
    final String? availability = state.selectedAvailability;
    emit(
      StillLookingState(
        status: state.status,
        dto: previous,
        availabilityOptions: state.availabilityOptions,
        storedAvailability: state.storedAvailability,
        selectedAvailability: availability,
        saving: true,
      ),
    );
    try {
      if (availability != null && _profileRepository != null) {
        await _profileRepository.saveWorkPreferences(
          availabilityPromptBody(
            availability,
            stored: state.storedAvailability,
          ),
        );
      }
      final StillLookingDto fresh = await _repository.answer(answer);
      if (isClosed) return;
      emit(
        StillLookingState(
          status: StillLookingStatus.ready,
          dto: fresh,
          availabilityOptions: state.availabilityOptions,
          storedAvailability: state.storedAvailability,
          saving: false,
          answered: true,
        ),
      );
    } on Failure catch (f) {
      if (isClosed) return;
      emit(
        StillLookingState(
          status: state.status,
          dto: previous,
          availabilityOptions: state.availabilityOptions,
          storedAvailability: state.storedAvailability,
          selectedAvailability: availability,
          failure: f,
        ),
      );
    } catch (_) {
      if (isClosed) return;
      emit(
        StillLookingState(
          status: state.status,
          dto: previous,
          availabilityOptions: state.availabilityOptions,
          storedAvailability: state.storedAvailability,
          selectedAvailability: availability,
          failure: const UnknownFailure(),
        ),
      );
    }
  }

  static bool _switchOff(Failure f) =>
      f is ServerFailure && f.statusCode == 404;
}
