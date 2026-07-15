import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../auth/domain/auth_session_manager.dart';
import '../../domain/consent_repository.dart';

enum ConsentStatus { idle, submitting, success, failure }

class ConsentState extends Equatable {
  const ConsentState({
    this.accepted = false,
    this.status = ConsentStatus.idle,
    this.message,
  });

  /// Whether the "I agree" box is ticked (presentation state held here so the
  /// widget stays logic-free).
  final bool accepted;
  final ConsentStatus status;
  final String? message;

  bool get isSubmitting => status == ConsentStatus.submitting;
  bool get canSubmit => accepted && !isSubmitting;

  ConsentState copyWith({bool? accepted, ConsentStatus? status, String? message}) {
    return ConsentState(
      accepted: accepted ?? this.accepted,
      status: status ?? this.status,
      message: message ?? this.message,
    );
  }

  @override
  List<Object?> get props => <Object?>[accepted, status, message];
}

class ConsentCubit extends Cubit<ConsentState> {
  ConsentCubit(this._repo) : super(const ConsentState());

  final ConsentRepository _repo;

  /// Phase-1 consent purposes (mirrors the original screen).
  static const List<String> _purposes = <String>['profiling', 'resume_generation'];

  void setAccepted(bool accepted) => emit(state.copyWith(accepted: accepted));

  Future<void> submit() async {
    if (!state.canSubmit) return;
    emit(state.copyWith(status: ConsentStatus.submitting));
    try {
      await _repo.acceptConsent(purposes: _purposes);
      if (isClosed) return;
      // TD62: release the router's consent gate immediately after a successful
      // consent.accepted — guarded lookup so plain cubit tests (no auth graph
      // in the locator) keep constructing ConsentCubit directly.
      if (locator.isRegistered<AuthSessionManager>()) {
        locator<AuthSessionManager>().markConsentAccepted();
      }
      emit(state.copyWith(status: ConsentStatus.success));
    } on Failure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(status: ConsentStatus.failure, message: failure.message));
    }
  }
}
