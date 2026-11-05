import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/consent_repository.dart';
import '../../domain/employer_sharing_prompt_gate.dart';

enum EmployerSharingPromptStatus { idle, submitting, granted, dismissed, failed }

class EmployerSharingPromptState extends Equatable {
  const EmployerSharingPromptState({
    this.status = EmployerSharingPromptStatus.idle,
    this.failure,
  });

  final EmployerSharingPromptStatus status;

  /// Set only in [EmployerSharingPromptStatus.failed].
  final Failure? failure;

  bool get isSubmitting => status == EmployerSharingPromptStatus.submitting;

  /// Both buttons are live unless a grant is in flight or the screen closed.
  bool get canAct =>
      status == EmployerSharingPromptStatus.idle ||
      status == EmployerSharingPromptStatus.failed;

  @override
  List<Object?> get props => <Object?>[status, failure];
}

/// The employer-sharing prompt (existing workers + the Settings switch's way
/// back ON). "Haan" writes the grant; "Abhi nahi" only remembers the answer on
/// this device and never calls the network.
class EmployerSharingPromptCubit extends Cubit<EmployerSharingPromptState> {
  EmployerSharingPromptCubit(this._repo, this._gate)
      : super(const EmployerSharingPromptState());

  final ConsentRepository _repo;
  final EmployerSharingPromptGate _gate;

  Future<void> grant() async {
    if (!state.canAct || _dismissing) return;
    emit(const EmployerSharingPromptState(
      status: EmployerSharingPromptStatus.submitting,
    ));
    try {
      await _repo.grantEmployerContact();
      if (isClosed) return;
      emit(const EmployerSharingPromptState(
        status: EmployerSharingPromptStatus.granted,
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(EmployerSharingPromptState(
        status: EmployerSharingPromptStatus.failed,
        failure: f,
      ));
    }
  }

  Future<void> dismiss() async {
    if (!state.canAct || _dismissing) return;
    _dismissing = true;
    await _gate.recordDismissal();
    if (isClosed) return;
    emit(const EmployerSharingPromptState(
      status: EmployerSharingPromptStatus.dismissed,
    ));
  }

  /// Fences a second tap (or a "Haan") during the local dismissal write.
  bool _dismissing = false;
}
