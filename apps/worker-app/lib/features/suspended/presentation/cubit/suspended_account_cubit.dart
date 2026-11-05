import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart';
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';

/// Which DPDP exit the worker is exercising on the suspended screen.
enum SuspendedAction { deleteAccount, withdrawConsent }

enum SuspendedAccountStatus {
  idle,
  requestingOtp,
  otpSent,
  confirming,
  withdrawing,
  deletionScheduled,
  consentWithdrawn,
  error,
}

class SuspendedAccountState extends Equatable {
  const SuspendedAccountState({
    this.status = SuspendedAccountStatus.idle,
    this.action,
    this.resendInSeconds = 0,
    this.scheduledFor,
    this.failure,
  });

  final SuspendedAccountStatus status;
  final SuspendedAction? action;

  /// Server cooldown for a delete-OTP resend.
  final int resendInSeconds;

  /// When the confirmed deletion is due (the normal 7-day grace window).
  final DateTime? scheduledFor;

  /// Typed, worker-safe cause when [status] is [SuspendedAccountStatus.error].
  final Failure? failure;

  bool get isBusy =>
      status == SuspendedAccountStatus.requestingOtp ||
      status == SuspendedAccountStatus.confirming ||
      status == SuspendedAccountStatus.withdrawing;

  SuspendedAccountState copyWith({
    SuspendedAccountStatus? status,
    SuspendedAction? action,
    int? resendInSeconds,
    DateTime? scheduledFor,
    Failure? failure,
  }) => SuspendedAccountState(
    status: status ?? this.status,
    action: action ?? this.action,
    resendInSeconds: resendInSeconds ?? this.resendInSeconds,
    scheduledFor: scheduledFor ?? this.scheduledFor,
    failure: failure,
  );

  @override
  List<Object?> get props => <Object?>[
    status,
    action,
    resendInSeconds,
    scheduledFor,
    failure,
  ];
}

/// The DPDP exits available on the suspended screen.
///
/// The ONLY thing this cubit ever does with the restricted token is pass it to
/// `ApiClient`'s account-delete request/confirm/cancel and consent-withdraw
/// calls. It never writes it to [SessionRepository], secure storage, a push
/// registration, or any other API route.
class SuspendedAccountCubit extends Cubit<SuspendedAccountState> {
  SuspendedAccountCubit({String? restrictedToken, ApiClient? api})
    : _restrictedToken = restrictedToken,
      _api = api,
      super(const SuspendedAccountState());

  final String? _restrictedToken;
  final ApiClient? _api;

  ApiClient get _client => _api ?? locator<ApiClient>();

  /// Whether the screen may offer the DPDP exits at all. A backend without
  /// #2679 sends no token, and the screen then shows message + support only.
  bool get hasRestrictedToken =>
      _restrictedToken != null && _restrictedToken.isNotEmpty;

  String? get _tokenOrNull => hasRestrictedToken ? _restrictedToken : null;

  /// Step 1 — request the delete OTP. The restricted token is the bearer here,
  /// exactly as a normal session token would be for Settings, but it remains
  /// local to this call.
  Future<void> requestDelete() async {
    final String? token = _tokenOrNull;
    if (token == null) {
      _emitError(
        SuspendedAction.deleteAccount,
        const UnauthorizedFailure(
          'Account delete ke liye dobara phone se verify karein.',
        ),
      );
      return;
    }
    emit(
      state.copyWith(
        status: SuspendedAccountStatus.requestingOtp,
        action: SuspendedAction.deleteAccount,
        failure: null,
      ),
    );
    try {
      final AccountDeleteRequestResult res = await _client.requestAccountDelete(
        authToken: token,
      );
      if (isClosed) return;
      emit(
        SuspendedAccountState(
          status: SuspendedAccountStatus.otpSent,
          action: SuspendedAction.deleteAccount,
          resendInSeconds: res.resendInSeconds,
        ),
      );
    } catch (error) {
      if (isClosed) return;
      _emitError(SuspendedAction.deleteAccount, mapError(error));
    }
  }

  /// Step 2 — confirm the deletion with the OTP. On success the delete is only
  /// SCHEDULED (the normal grace window); the suspended screen stays up.
  Future<void> confirmDelete(String otp) async {
    final String? token = _tokenOrNull;
    if (token == null) {
      _emitError(
        SuspendedAction.deleteAccount,
        const UnauthorizedFailure(
          'Account delete ke liye dobara phone se verify karein.',
        ),
      );
      return;
    }
    emit(
      state.copyWith(
        status: SuspendedAccountStatus.confirming,
        action: SuspendedAction.deleteAccount,
        failure: null,
      ),
    );
    try {
      final AccountDeleteConfirmResult res = await _client.confirmAccountDelete(
        authToken: token,
        otp: otp,
      );
      if (isClosed) return;
      emit(
        SuspendedAccountState(
          status: SuspendedAccountStatus.deletionScheduled,
          action: SuspendedAction.deleteAccount,
          scheduledFor: res.scheduledFor,
          resendInSeconds: state.resendInSeconds,
        ),
      );
    } catch (error) {
      if (isClosed) return;
      emit(
        state.copyWith(
          status: SuspendedAccountStatus.error,
          action: SuspendedAction.deleteAccount,
          failure: _mapConfirmError(error),
        ),
      );
    }
  }

  /// Withdraw DPDP consent. The server revokes the worker's sessions, but the
  /// suspended screen has already cleared local state, so there is nothing left
  /// to log out of locally.
  Future<void> withdrawConsent() async {
    final String? token = _tokenOrNull;
    if (token == null) {
      _emitError(
        SuspendedAction.withdrawConsent,
        const UnauthorizedFailure(
          'Consent wapas lene ke liye dobara phone se verify karein.',
        ),
      );
      return;
    }
    emit(
      state.copyWith(
        status: SuspendedAccountStatus.withdrawing,
        action: SuspendedAction.withdrawConsent,
        failure: null,
      ),
    );
    try {
      await _client.withdrawConsent(authToken: token);
      if (isClosed) return;
      emit(
        const SuspendedAccountState(
          status: SuspendedAccountStatus.consentWithdrawn,
          action: SuspendedAction.withdrawConsent,
        ),
      );
    } catch (error) {
      if (isClosed) return;
      _emitError(SuspendedAction.withdrawConsent, mapError(error));
    }
  }

  void _emitError(SuspendedAction action, Failure failure) {
    emit(
      SuspendedAccountState(
        status: SuspendedAccountStatus.error,
        action: action,
        resendInSeconds: state.resendInSeconds,
        failure: failure,
      ),
    );
  }

  /// A delete-confirm 401 means the OTP was wrong, NOT that the session died,
  /// so it must never read "please log in again" (the same rule Settings uses).
  Failure _mapConfirmError(Object error) {
    if (error is ApiException) {
      return switch (error.statusCode) {
        401 => const OtpInvalidFailure(),
        429 => const RateLimitedFailure(),
        _ => ServerFailure(error.statusCode),
      };
    }
    return mapError(error);
  }
}
