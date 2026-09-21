import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/session/known_worker_facts_store.dart';
import '../../../../core/util/title_case.dart';
import '../../domain/name_repository.dart';

enum NameStatus { idle, submitting, success, failed }

/// State for the "Your name" step. Deliberately carries NO name — the plaintext
/// name lives only in the text field + the in-flight call, never in BLoC state
/// (CLAUDE.md §2: PII stays out of app state / logs).
class NameState extends Equatable {
  const NameState({this.status = NameStatus.idle});

  final NameStatus status;

  bool get isSubmitting => status == NameStatus.submitting;

  @override
  List<Object?> get props => <Object?>[status];
}

/// Drives the "Your name" onboarding step: submit the name (+ coarse
/// city/state, if captured) once, then continue to chat profiling. Nothing
/// is stored on the cubit — everything is a method argument. A failure
/// surfaces a retry rather than a stuck spinner.
class NameCubit extends Cubit<NameState> {
  NameCubit(this._repo, {KnownWorkerFactsStore? knownFacts})
      : _knownFacts = knownFacts,
        super(const NameState());

  final NameRepository _repo;

  /// Records that the current city was given, once the server saved one, so a
  /// later trade form does not ask it again. A worker who skipped the location
  /// prompt records nothing and is asked there. Stores the fact name only,
  /// never the city.
  final KnownWorkerFactsStore? _knownFacts;

  Future<void> submit(
    String fullName, {
    String? city,
    String? state,
  }) async {
    final String trimmed = titleCaseName(fullName.trim());
    if (trimmed.isEmpty || this.state.isSubmitting) return;
    final String? trimmedCity = _titleCaseOrNull(city);
    final String? trimmedState = _titleCaseOrNull(state);
    emit(const NameState(status: NameStatus.submitting));
    try {
      await _repo.submitName(
        trimmed,
        city: trimmedCity,
        state: trimmedState,
      );
      final KnownWorkerFactsStore? facts = _knownFacts;
      if (trimmedCity != null && facts != null) {
        unawaited(facts.record(WorkerFact.currentCity));
      }
      if (isClosed) return;
      emit(const NameState(status: NameStatus.success));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const NameState(status: NameStatus.failed));
    }
  }

  String? _titleCaseOrNull(String? value) =>
      (value != null && value.trim().isNotEmpty)
          ? titleCaseName(value.trim())
          : null;
}
