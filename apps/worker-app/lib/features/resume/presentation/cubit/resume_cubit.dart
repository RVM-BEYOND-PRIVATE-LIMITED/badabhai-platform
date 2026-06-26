import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/resume_repository.dart';

enum ResumeStatus { loading, ready, failed }

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
}
