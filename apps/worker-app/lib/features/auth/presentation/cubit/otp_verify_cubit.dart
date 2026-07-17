import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_api.dart';
import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum OtpVerifyStatus { initial, submitting, success, failure }

/// Where the OTP-verify success routes next.
///
///  - [onboarding] — persistent-auth OFF (an explicit `PERSISTENT_AUTH=false`
///    build; the layer is ON by default): replicate main's OTP→consent
///    onboarding; no PIN. The API bearer is the only auth gate.
///  - [setPin]    — new user or `pin_set=false`: must choose a PIN first.
///  - [authenticated] — returning worker with a PIN: straight into the app.
enum OtpNext { onboarding, setPin, authenticated }

class OtpVerifyState extends Equatable {
  const OtpVerifyState({
    this.status = OtpVerifyStatus.initial,
    this.message,
    this.next,
    this.deletionScheduledFor,
  });

  final OtpVerifyStatus status;
  final String? message;

  /// Set on success — the screen routes off this (set-PIN vs straight in).
  final OtpNext? next;

  /// Set on success when an account deletion is pending (ADR-0031 grace
  /// window): when the deletion is due. The screen shows the explicit
  /// cancel-prompt BEFORE routing; null = no deletion pending.
  final DateTime? deletionScheduledFor;

  bool get isSubmitting => status == OtpVerifyStatus.submitting;

  /// Copies the state, overriding only the fields passed.
  ///
  /// [deletionScheduledFor] is DELIBERATELY NOT a parameter (ADR-0031, same
  /// reasoning as [Session.copyWith]): its null means "no deletion pending", and
  /// a `??` merge cannot express that — it would silently retain a stale date.
  /// The success path builds the state with the explicit constructor, which is
  /// now the ONLY way to set or clear this field. The submitting/failure paths
  /// below carry the current value through untouched; they never route off it.
  OtpVerifyState copyWith({
    OtpVerifyStatus? status,
    String? message,
    OtpNext? next,
  }) {
    return OtpVerifyState(
      status: status ?? this.status,
      message: message,
      next: next ?? this.next,
      deletionScheduledFor: deletionScheduledFor,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, message, next, deletionScheduledFor];
}

/// Drives OTP verification through [AuthSessionManager]. On success the manager
/// has persisted tokens + bridged them into the legacy session; this cubit
/// exposes the routing flag (set-PIN vs authenticated) for the screen.
class OtpVerifyCubit extends Cubit<OtpVerifyState> {
  OtpVerifyCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const OtpVerifyState());

  final AuthSessionManager _manager;
  final String _locale;

  Future<void> verify({required String phone, required String otp}) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: OtpVerifyStatus.submitting));
    try {
      final OtpVerifyResult result = await _manager.verifyOtp(phone, otp);
      if (isClosed) return;
      // Route off the manager — the single source of truth that respects the
      // persistent-auth gate. Gate OFF (explicit dart-define only) → main's
      // OTP→consent onboarding (no PIN). Gate ON (the default) → `locked` means
      // a new user must set a PIN, anything else means a returning worker goes
      // straight to the shell.
      final OtpNext next;
      if (!_manager.persistentAuthEnabled) {
        next = OtpNext.onboarding; // gate OFF → main's OTP→consent flow
      } else if (_manager.status == AuthStatus.locked) {
        next = OtpNext.setPin; // new user → set a PIN
      } else {
        next = OtpNext.authenticated; // returning worker → shell
      }
      // Built EXPLICITLY, not via copyWith: copyWith's `??` merge cannot
      // express "no deletion pending" — a null [result.deletionScheduledFor]
      // would silently retain a STALE date from an earlier verify on this same
      // cubit (the screen survives behind a pushed consent route), prompting a
      // cancel for a deletion that no longer exists. ADR-0031 honest nulls: the
      // server response is authoritative, including its absence.
      emit(OtpVerifyState(
        status: OtpVerifyStatus.success,
        next: next,
        // Surfaced so the screen can prompt the explicit cancel before routing;
        // null (the usual case) means no deletion pending.
        deletionScheduledFor: result.deletionScheduledFor,
      ));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: OtpVerifyStatus.failure,
        message: authErrorMessage(failure, _locale),
      ));
    }
  }
}
