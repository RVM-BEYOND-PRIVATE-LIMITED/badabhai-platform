import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/resume_repository.dart';

enum ResumeStatus { loading, ready, failed, noProfile }

class ResumeState extends Equatable {
  const ResumeState({this.status = ResumeStatus.loading, this.resumeText = ''});

  final ResumeStatus status;
  final String resumeText;

  @override
  List<Object?> get props => <Object?>[status, resumeText];
}

/// Drives the resume screen: a single generate-on-open action. A failure shows
/// the app's standard retry view (rather than the original's stuck spinner).
class ResumeCubit extends Cubit<ResumeState> {
  ResumeCubit(this._repo) : super(const ResumeState());

  final ResumeRepository _repo;

  /// True while a load is in flight. The tab-focus refetch and the screen's own
  /// create:-time load can both fire around a first visit, and a second
  /// concurrent load would double the network work and race its emits.
  bool _loading = false;

  /// Loads the resume — reusing the existing one unless [force].
  ///
  /// [force] is for a deliberate rebuild after the worker edits their NAME (it
  /// is baked in at generation time, so a PATCHed name is invisible until the
  /// resume is regenerated). It re-POSTs generate, which server-side also resets
  /// the PDF to pending and re-enqueues the render, so the downloaded file
  /// carries the new name too (#398). Never force on a routine open: it spends
  /// one of the worker's 5 daily generates and throws away the rendered PDF.
  Future<void> generate({bool force = false}) async {
    if (_loading) return; // never run two loads at once
    _loading = true;
    emit(const ResumeState(status: ResumeStatus.loading));
    try {
      final String text = await _repo.generateResume(force: force);
      if (isClosed) return; // screen popped before generation resolved
      emit(ResumeState(status: ResumeStatus.ready, resumeText: text));
    } on ProfileIncompleteFailure {
      if (isClosed) return;
      emit(const ResumeState(status: ResumeStatus.noProfile));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const ResumeState(status: ResumeStatus.failed));
    } finally {
      _loading = false;
    }
  }

  /// Tab-focus refetch (T4) — the Resume tab came back into view.
  ///
  /// NEVER forces. A force here would re-POST /resume/generate on every tab
  /// switch, which server-side overwrites the row, resets the PDF to 'pending'
  /// and re-enqueues the render — so the worker's already-rendered PDF would be
  /// binned on each visit and their 5/day generate cap burned to do it. This is
  /// a read that REUSES the existing resume.
  ///
  /// Also does not emit `loading` and does not wipe on failure: the worker is
  /// looking at a readable resume, and a blip on a background refetch must not
  /// replace it with a spinner or an error screen. A stale resume beats no
  /// resume.
  Future<void> refresh() async {
    if (_loading) return;
    _loading = true;
    try {
      final String text = await _repo.generateResume(); // force: false → reuse
      if (isClosed) return;
      emit(ResumeState(status: ResumeStatus.ready, resumeText: text));
    } on ProfileIncompleteFailure {
      if (isClosed) return;
      if (state.status != ResumeStatus.ready) {
        emit(const ResumeState(status: ResumeStatus.noProfile));
      }
    } on Failure catch (_) {
      if (isClosed) return;
      // Keep whatever the worker can already read; only surface the failure
      // when there was nothing good on screen to begin with.
      if (state.status != ResumeStatus.ready) {
        emit(const ResumeState(status: ResumeStatus.failed));
      }
    } finally {
      _loading = false;
    }
  }

  /// Display an already-generated resume (generated upstream by the Building
  /// screen) without re-running generation.
  void showGenerated(String text) {
    emit(ResumeState(status: ResumeStatus.ready, resumeText: text));
  }

  /// Resolves a short-lived signed url for the resume PDF, or null if it could
  /// not be fetched (the screen then shows a user-safe message). Does NOT change
  /// [ResumeState] — the resume is already shown; this is a side action. The url
  /// is returned for an immediate IN-APP fetch only and is never stored or
  /// logged. Lets a [Failure] PROPAGATE (does not swallow it to null) so
  /// `downloadSignedPdf` can surface the ACTUAL reason (server / 401 /
  /// PDF-not-rendered) instead of a blank generic line.
  Future<String?> resolveDownloadUrl() => _repo.resumeDownloadUrl();
}
