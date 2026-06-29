import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum SetPinStatus { idle, submitting, done, failure }

class SetPinState extends Equatable {
  const SetPinState({this.status = SetPinStatus.idle, this.message});

  final SetPinStatus status;
  final String? message;

  bool get isSubmitting => status == SetPinStatus.submitting;

  SetPinState copyWith({SetPinStatus? status, String? message}) => SetPinState(
        status: status ?? this.status,
        message: message,
      );

  @override
  List<Object?> get props => <Object?>[status, message];
}

/// Drives set-PIN (new user / reset). Holds NO PIN: [submit] receives the
/// confirmed PIN, forwards it to [AuthSessionManager.setPin], and drops it. On
/// success the manager flips to authenticated and the router lets the worker in.
class SetPinCubit extends Cubit<SetPinState> {
  SetPinCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const SetPinState());

  final AuthSessionManager _manager;
  final String _locale;

  Future<void> submit(String pin) async {
    if (state.isSubmitting) return;
    emit(const SetPinState(status: SetPinStatus.submitting));
    try {
      await _manager.setPin(pin);
      if (isClosed) return;
      emit(const SetPinState(status: SetPinStatus.done));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(SetPinState(
        status: SetPinStatus.failure,
        message: authErrorMessage(failure, _locale),
      ));
    }
  }
}
