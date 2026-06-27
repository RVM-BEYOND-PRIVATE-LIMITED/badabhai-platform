import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
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

/// Drives the "Your name" onboarding step: submit the name once, then continue
/// to chat profiling. The name is passed as a method argument (never stored on
/// the cubit). A failure surfaces a retry rather than a stuck spinner.
class NameCubit extends Cubit<NameState> {
  NameCubit(this._repo) : super(const NameState());

  final NameRepository _repo;

  Future<void> submit(String fullName) async {
    final String trimmed = fullName.trim();
    if (trimmed.isEmpty || state.isSubmitting) return;
    emit(const NameState(status: NameStatus.submitting));
    try {
      await _repo.submitName(trimmed);
      if (isClosed) return;
      emit(const NameState(status: NameStatus.success));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const NameState(status: NameStatus.failed));
    }
  }
}
