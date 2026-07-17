import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart';
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../../../core/session/session_repository.dart';

enum AccountDeleteStatus {
  idle,
  sendingOtp,
  otpSent,
  confirming,
  scheduled,
  cancelling,
  error,
}

class AccountDeleteState extends Equatable {
  const AccountDeleteState({
    this.status = AccountDeleteStatus.idle,
    this.resendInSeconds = 0,
    this.scheduledFor,
    this.failure,
  });

  final AccountDeleteStatus status;

  /// Cooldown (seconds) before another delete-OTP can be requested — from the
  /// request response. The OTP dialog counts it down.
  final int resendInSeconds;

  /// When the pending deletion is due (ADR-0031 grace window). Set while
  /// [status] is `scheduled`/`cancelling`; null otherwise. May be null even
  /// when scheduled (defensive parse) — the UI falls back to "7 din" copy.
  final DateTime? scheduledFor;

  /// The typed cause when [status] is `error` — or, on a failed CANCEL, while
  /// [status] STAYS `scheduled` (the banner survives so the worker can retry).
  /// The dialog/banner surfaces its honest reason via failure_reason.
  final Failure? failure;

  AccountDeleteState copyWith({
    AccountDeleteStatus? status,
    int? resendInSeconds,
    DateTime? scheduledFor,
    Failure? failure,
  }) =>
      AccountDeleteState(
        status: status ?? this.status,
        resendInSeconds: resendInSeconds ?? this.resendInSeconds,
        scheduledFor: scheduledFor ?? this.scheduledFor,
        failure: failure,
      );

  @override
  List<Object?> get props =>
      <Object?>[status, resendInSeconds, scheduledFor, failure];
}

/// Owns the DPDP account-delete flow (A4 + ADR-0031 grace window): request OTP
/// → confirm OTP → SCHEDULED (7-day grace) → optional cancel.
///
/// On a confirmed 200 the deletion is only SCHEDULED — local credentials are
/// deliberately NOT wiped and no reauth fires: the worker keeps using the app
/// during the grace so they CAN cancel (from the Settings banner or the
/// post-login prompt). [cancelDelete] clears the pending flag everywhere.
/// FAIL-CLOSED: a wrong OTP (401) surfaces [OtpInvalidFailure] (NOT "session
/// expired"), a 429 surfaces [RateLimitedFailure]; nothing is scheduled unless
/// the server confirms it.
///
/// The deps are optional named seams resolved LAZILY from the locator when
/// omitted (mirrors ProfileTabCubit) so tests inject fakes without a wired graph.
class AccountDeleteCubit extends Cubit<AccountDeleteState> {
  AccountDeleteCubit({
    ApiClient? api,
    SessionRepository? session,
  })  : _api = api,
        _session = session,
        super(_seedState(session));

  final ApiClient? _api;
  final SessionRepository? _session;

  ApiClient get _apiClient => _api ?? locator<ApiClient>();
  SessionRepository get _sessionRepo => _session ?? locator<SessionRepository>();

  /// A worker who logged in during a pending grace window starts SCHEDULED
  /// (the login response flag was stored on the SessionRepository), so Settings
  /// shows the pending banner immediately instead of the delete row.
  static AccountDeleteState _seedState(SessionRepository? session) {
    final DateTime? pending =
        (session ?? locator<SessionRepository>()).deletionScheduledFor;
    return pending == null
        ? const AccountDeleteState()
        : AccountDeleteState(
            status: AccountDeleteStatus.scheduled,
            scheduledFor: pending,
          );
  }

  String? _tokenOrNull() {
    final String? token = _sessionRepo.sessionToken;
    return (token == null || token.isEmpty) ? null : token;
  }

  /// Step 1: start the delete OTP flow. On success moves to `otpSent` carrying
  /// the resend cooldown.
  Future<void> requestDelete() async {
    final String? token = _tokenOrNull();
    if (token == null) {
      emit(const AccountDeleteState(
          status: AccountDeleteStatus.error, failure: UnauthorizedFailure()));
      return;
    }
    emit(state.copyWith(status: AccountDeleteStatus.sendingOtp, failure: null));
    try {
      final AccountDeleteRequestResult res =
          await _apiClient.requestAccountDelete(authToken: token);
      if (isClosed) return;
      emit(AccountDeleteState(
        status: AccountDeleteStatus.otpSent,
        resendInSeconds: res.resendInSeconds,
      ));
    } catch (error) {
      if (isClosed) return;
      emit(AccountDeleteState(
          status: AccountDeleteStatus.error, failure: mapError(error)));
    }
  }

  /// Step 2: confirm with [otp]. On a 200 the deletion is SCHEDULED (ADR-0031)
  /// — credentials are NOT wiped and no reauth fires (the worker keeps their
  /// session so they can cancel during the grace); the pending flag is stored
  /// on the SessionRepository and the state moves to `scheduled`. FAIL-CLOSED
  /// error mapping is delete-specific (401 → bad OTP, not re-login).
  Future<void> confirmDelete(String otp) async {
    final String? token = _tokenOrNull();
    if (token == null) {
      emit(const AccountDeleteState(
          status: AccountDeleteStatus.error, failure: UnauthorizedFailure()));
      return;
    }
    emit(state.copyWith(status: AccountDeleteStatus.confirming, failure: null));
    try {
      final AccountDeleteConfirmResult res =
          await _apiClient.confirmAccountDelete(authToken: token, otp: otp);
      // Keep the SessionRepository in sync — it seeds this cubit and drives
      // the post-login cancel prompt.
      _sessionRepo.setDeletionScheduledFor(res.scheduledFor);
      if (isClosed) return;
      emit(AccountDeleteState(
        status: AccountDeleteStatus.scheduled,
        scheduledFor: res.scheduledFor,
      ));
    } catch (error) {
      if (isClosed) return;
      emit(AccountDeleteState(
        status: AccountDeleteStatus.error,
        resendInSeconds: state.resendInSeconds,
        failure: _mapConfirmError(error),
      ));
    }
  }

  /// Cancels the pending deletion (POST /auth/account/delete/cancel —
  /// idempotent, bearer only; cancel is recoverable so it needs no OTP). On
  /// success the pending flag is cleared everywhere (state + SessionRepository)
  /// and the state returns to `idle`; on failure the state STAYS `scheduled`
  /// with the typed cause, so the banner survives and the worker can retry.
  Future<void> cancelDelete() async {
    final String? token = _tokenOrNull();
    if (token == null) {
      emit(state.copyWith(
          status: AccountDeleteStatus.scheduled,
          failure: const UnauthorizedFailure()));
      return;
    }
    emit(state.copyWith(status: AccountDeleteStatus.cancelling, failure: null));
    try {
      await _apiClient.cancelAccountDelete(authToken: token);
      _sessionRepo.setDeletionScheduledFor(null);
      if (isClosed) return;
      emit(const AccountDeleteState());
    } catch (error) {
      if (isClosed) return;
      emit(AccountDeleteState(
        status: AccountDeleteStatus.scheduled,
        scheduledFor: state.scheduledFor,
        failure: mapError(error),
      ));
    }
  }

  /// Delete-confirm error mapping. 401 here means the OTP was wrong (NOT the
  /// session), so it maps to [OtpInvalidFailure] rather than the global
  /// [UnauthorizedFailure] mapError would return.
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
