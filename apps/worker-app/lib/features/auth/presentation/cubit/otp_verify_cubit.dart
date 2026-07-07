import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum OtpVerifyStatus { initial, submitting, success, failure }

/// Where the OTP-verify success routes next.
///
///  - [onboarding] — start the consent onboarding (OTP → consent → name → chat).
///    Used when persistent-auth is OFF (real/default build: no PIN, the API
///    bearer is the only gate) AND for a gate-ON returning worker who has NOT
///    completed consent (`consent_accepted == false`) — both must pass through
///    consent, never the shell.
///  - [setPin]    — new user or `pin_set=false`: must choose a PIN first.
///  - [authenticated] — returning worker with a PIN who HAS consented: straight
///    into the app.
enum OtpNext { onboarding, setPin, authenticated }

class OtpVerifyState extends Equatable {
  const OtpVerifyState({
    this.status = OtpVerifyStatus.initial,
    this.message,
    this.next,
  });

  final OtpVerifyStatus status;
  final String? message;

  /// Set on success — the screen routes off this (set-PIN vs straight in).
  final OtpNext? next;

  bool get isSubmitting => status == OtpVerifyStatus.submitting;

  OtpVerifyState copyWith({
    OtpVerifyStatus? status,
    String? message,
    OtpNext? next,
  }) {
    return OtpVerifyState(
      status: status ?? this.status,
      message: message,
      next: next ?? this.next,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, message, next];
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
      await _manager.verifyOtp(phone, otp);
      if (isClosed) return;
      // Route off the manager — the single source of truth that respects the
      // persistent-auth gate. Gate OFF (real/default build) → main's OTP→consent
      // onboarding (no PIN). Gate ON → `locked` means a new user must set a PIN,
      // anything else means a returning worker goes straight to the shell.
      final OtpNext next;
      if (!_manager.persistentAuthEnabled) {
        next = OtpNext.onboarding; // gate OFF → main's OTP→consent flow
      } else if (_manager.status == AuthStatus.locked) {
        next = OtpNext.setPin; // new user → set a PIN
      } else if (!_manager.consentAccepted) {
        // Returning worker WITH a PIN but who never completed consent → route to
        // the consent flow, not the shell (mirrors the router's consent gate, so
        // the OTP path doesn't flash the shell before being bounced to /consent).
        next = OtpNext.onboarding;
      } else {
        next = OtpNext.authenticated; // returning + consented → shell
      }
      emit(state.copyWith(status: OtpVerifyStatus.success, next: next));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: OtpVerifyStatus.failure,
        message: authErrorMessage(failure, _locale),
      ));
    }
  }
}
