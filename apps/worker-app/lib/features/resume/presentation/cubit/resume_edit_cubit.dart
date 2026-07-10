import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/resume_edit_repository.dart';
import '../../domain/resume_safe_fields.dart';

enum ResumeEditStatus { loading, ready, failed }

class ResumeEditState extends Equatable {
  const ResumeEditState({
    this.status = ResumeEditStatus.loading,
    this.fields,
    this.saving = false,
    this.savedNonce = 0,
    this.failure,
  });

  final ResumeEditStatus status;
  final ResumeSafeFields? fields;
  final bool saving;

  /// Bumped on a successful save — the screen shows a snackbar + pops once.
  final int savedNonce;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  ResumeEditState copyWith({
    ResumeEditStatus? status,
    ResumeSafeFields? fields,
    bool? saving,
    int? savedNonce,
  }) {
    return ResumeEditState(
      status: status ?? this.status,
      fields: fields ?? this.fields,
      saving: saving ?? this.saving,
      savedNonce: savedNonce ?? this.savedNonce,
      failure: failure,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, fields, saving, savedNonce, failure];
}

/// Drives the resume safe-field edit screen (spec §5.2): load the editable
/// fields on open, let the worker flip the toggles / fix the name spelling,
/// then save through the repository.
class ResumeEditCubit extends Cubit<ResumeEditState> {
  ResumeEditCubit(this._repo) : super(const ResumeEditState());

  final ResumeEditRepository _repo;
  bool _saving = false;

  Future<void> load() async {
    emit(const ResumeEditState(status: ResumeEditStatus.loading));
    try {
      final ResumeSafeFields fields = await _repo.load();
      if (isClosed) return; // screen popped before load resolved
      emit(ResumeEditState(status: ResumeEditStatus.ready, fields: fields));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(ResumeEditState(status: ResumeEditStatus.failed, failure: f));
    }
  }

  void setDisplayName(String value) {
    final ResumeSafeFields? fields = state.fields;
    if (fields == null) return;
    emit(state.copyWith(
      status: ResumeEditStatus.ready,
      fields: fields.copyWith(displayName: value),
    ));
  }

  void setShowPhoto(bool value) {
    final ResumeSafeFields? fields = state.fields;
    if (fields == null) return;
    emit(state.copyWith(
      status: ResumeEditStatus.ready,
      fields: fields.copyWith(showPhoto: value),
    ));
  }

  void setShowPhone(bool value) {
    final ResumeSafeFields? fields = state.fields;
    if (fields == null) return;
    emit(state.copyWith(
      status: ResumeEditStatus.ready,
      fields: fields.copyWith(showPhone: value),
    ));
  }

  void setNightShiftReady(bool value) {
    final ResumeSafeFields? fields = state.fields;
    if (fields == null) return;
    emit(state.copyWith(
      status: ResumeEditStatus.ready,
      fields: fields.copyWith(nightShiftReady: value),
    ));
  }

  Future<void> save() async {
    final ResumeSafeFields? fields = state.fields;
    if (fields == null || _saving) return;
    _saving = true;
    emit(state.copyWith(saving: true));
    try {
      await _repo.save(fields);
      if (isClosed) return;
      emit(state.copyWith(saving: false, savedNonce: state.savedNonce + 1));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(state.copyWith(saving: false));
    } finally {
      _saving = false;
    }
  }
}
