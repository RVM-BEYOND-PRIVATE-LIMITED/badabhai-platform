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

  Future<void> generate() async {
    emit(const ResumeState(status: ResumeStatus.loading));
    try {
      final String text = await _repo.generateResume();
      if (isClosed) return; // screen popped before generation resolved
      emit(ResumeState(status: ResumeStatus.ready, resumeText: text));
    } on ProfileIncompleteFailure {
      if (isClosed) return;
      emit(const ResumeState(status: ResumeStatus.noProfile));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const ResumeState(status: ResumeStatus.failed));
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
