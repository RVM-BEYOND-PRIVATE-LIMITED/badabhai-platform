import 'dart:typed_data';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../domain/photo_repository.dart';
import '../../domain/resume_edit_repository.dart';
import '../../domain/resume_safe_fields.dart';

enum ResumeEditStatus { loading, ready, failed }

class ResumeEditState extends Equatable {
  const ResumeEditState({
    this.status = ResumeEditStatus.loading,
    this.fields,
    this.saving = false,
    this.savedNonce = 0,
    this.saveErrorNonce = 0,
    this.failure,
    this.saveFailure,
    this.photoUrl,
    this.photoBusy = false,
  });

  final ResumeEditStatus status;
  final ResumeSafeFields? fields;
  final bool saving;

  /// Bumped on a successful save — the screen shows a snackbar + pops once.
  final int savedNonce;

  /// Bumped on a FAILED save (or a failed photo action — same honest snackbar) —
  /// the screen surfaces the reason and stays put so the worker can retry.
  final int saveErrorNonce;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  /// The typed cause of the last failed SAVE (drives the error snackbar). Distinct
  /// from [failure], which drives the full-screen load-failed view.
  final Failure? saveFailure;

  /// ADR-0032 — a short-lived SIGNED url for the current photo thumbnail, or null
  /// (no photo / not fetched / fetch degraded). In-memory only: never persisted,
  /// never logged; re-fetched on load and after every photo change.
  final String? photoUrl;

  /// True while a photo upload/remove is in flight (drives the row's spinner and
  /// disables the row — a second tap must not race the first).
  final bool photoBusy;

  ResumeEditState copyWith({
    ResumeEditStatus? status,
    ResumeSafeFields? fields,
    bool? saving,
    int? savedNonce,
    int? saveErrorNonce,
    Failure? saveFailure,
    String? photoUrl,
    bool clearPhotoUrl = false,
    bool? photoBusy,
  }) {
    return ResumeEditState(
      status: status ?? this.status,
      fields: fields ?? this.fields,
      saving: saving ?? this.saving,
      savedNonce: savedNonce ?? this.savedNonce,
      saveErrorNonce: saveErrorNonce ?? this.saveErrorNonce,
      failure: failure,
      saveFailure: saveFailure ?? this.saveFailure,
      photoUrl: clearPhotoUrl ? null : (photoUrl ?? this.photoUrl),
      photoBusy: photoBusy ?? this.photoBusy,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        fields,
        saving,
        savedNonce,
        saveErrorNonce,
        failure,
        saveFailure,
        photoUrl,
        photoBusy,
      ];
}

/// Drives the resume safe-field edit screen (spec §5.2): load the editable
/// fields on open, let the worker flip the toggles / fix the name spelling /
/// manage their photo (ADR-0032), then save through the repository.
class ResumeEditCubit extends Cubit<ResumeEditState> {
  ResumeEditCubit(this._repo, this._photos) : super(const ResumeEditState());

  final ResumeEditRepository _repo;
  final PhotoRepository _photos;
  bool _saving = false;
  bool _photoBusy = false;

  Future<void> load() async {
    emit(const ResumeEditState(status: ResumeEditStatus.loading));
    try {
      final ResumeSafeFields fields = await _repo.load();
      if (isClosed) return; // screen popped before load resolved
      emit(ResumeEditState(status: ResumeEditStatus.ready, fields: fields));
      await _refreshPhotoUrl(fields.hasPhoto);
    } on Failure catch (f) {
      if (isClosed) return;
      emit(ResumeEditState(status: ResumeEditStatus.failed, failure: f));
    }
  }

  /// Best-effort thumbnail url. A failure here degrades to the placeholder —
  /// it must never take down the loaded edit screen.
  Future<void> _refreshPhotoUrl(bool hasPhoto) async {
    if (!hasPhoto) {
      if (!isClosed) emit(state.copyWith(clearPhotoUrl: true));
      return;
    }
    try {
      final String? url = await _photos.photoUrl();
      if (isClosed) return;
      emit(url == null
          ? state.copyWith(clearPhotoUrl: true)
          : state.copyWith(photoUrl: url));
    } catch (_) {
      if (isClosed) return;
      emit(state.copyWith(clearPhotoUrl: true));
    }
  }

  /// ADR-0032 — upload (or replace) the photo. [bytes] is the on-device-resized
  /// JPEG from the picker. Errors surface via the same honest snackbar as save.
  Future<void> uploadPhoto(Uint8List bytes) async {
    final ResumeSafeFields? fields = state.fields;
    if (fields == null || _photoBusy) return;
    _photoBusy = true;
    emit(state.copyWith(photoBusy: true));
    try {
      await _photos.uploadPhoto(bytes);
      if (isClosed) return;
      emit(state.copyWith(
        photoBusy: false,
        fields: fields.copyWith(hasPhoto: true),
      ));
      await _refreshPhotoUrl(true);
    } catch (error) {
      if (isClosed) return;
      // Catch-all through mapError (same rationale as save(): the screen
      // discards the Future, so nothing may escape unhandled).
      emit(state.copyWith(
        photoBusy: false,
        saveErrorNonce: state.saveErrorNonce + 1,
        saveFailure: mapError(error),
      ));
    } finally {
      _photoBusy = false;
    }
  }

  /// ADR-0032 — remove the photo (idempotent server-side).
  Future<void> removePhoto() async {
    final ResumeSafeFields? fields = state.fields;
    if (fields == null || _photoBusy) return;
    _photoBusy = true;
    emit(state.copyWith(photoBusy: true));
    try {
      await _photos.removePhoto();
      if (isClosed) return;
      emit(state.copyWith(
        photoBusy: false,
        clearPhotoUrl: true,
        fields: fields.copyWith(hasPhoto: false),
      ));
    } catch (error) {
      if (isClosed) return;
      emit(state.copyWith(
        photoBusy: false,
        saveErrorNonce: state.saveErrorNonce + 1,
        saveFailure: mapError(error),
      ));
    } finally {
      _photoBusy = false;
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
    } catch (error) {
      if (isClosed) return;
      // Surface the failure so the screen can show an honest error (and let the
      // worker retry) — a real PATCH can 400/401/drop; don't swallow it silently.
      //
      // A CATCH-ALL rather than `on Failure`: the screen fires save() from
      // onPressed, which DISCARDS the returned Future, so anything the
      // repository failed to map would reach the zone unhandled instead of
      // reaching the worker. [mapError] is total and passes a [Failure] through
      // unchanged, so this stays honest (a raw socket drop still reads as
      // "server se connect nahi ho pa raha") and never forwards a server body.
      emit(state.copyWith(
        saving: false,
        saveErrorNonce: state.saveErrorNonce + 1,
        saveFailure: mapError(error),
      ));
    } finally {
      _saving = false;
    }
  }
}
