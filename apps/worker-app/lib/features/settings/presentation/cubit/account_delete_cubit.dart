import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart';
import '../../../../core/auth/reauth_signal.dart';
import '../../../../core/auth/secure_token_store.dart';
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../../../core/session/session_repository.dart';

enum AccountDeleteStatus { idle, sendingOtp, otpSent, confirming, deleted, error }

class AccountDeleteState extends Equatable {
  const AccountDeleteState({
    this.status = AccountDeleteStatus.idle,
    this.resendInSeconds = 0,
    this.failure,
  });

  final AccountDeleteStatus status;

  /// Cooldown (seconds) before another delete-OTP can be requested — from the
  /// request response. The OTP dialog counts it down.
  final int resendInSeconds;

  /// The typed cause when [status] is `error`. The dialog surfaces its honest
  /// reason (bad OTP vs rate-limit vs server) via failure_reason.
  final Failure? failure;

  AccountDeleteState copyWith({
    AccountDeleteStatus? status,
    int? resendInSeconds,
    Failure? failure,
  }) =>
      AccountDeleteState(
        status: status ?? this.status,
        resendInSeconds: resendInSeconds ?? this.resendInSeconds,
        failure: failure,
      );

  @override
  List<Object?> get props => <Object?>[status, resendInSeconds, failure];
}

/// Owns the 2-step DPDP account-delete flow (A4): request OTP → confirm OTP.
///
/// On a confirmed 204 it wipes the worker's local credentials — the in-memory
/// session AND the secure store (refresh token + worker id) — then fires the
/// reauth signal so the app returns to logged-out. The screen navigates to phone
/// login. FAIL-CLOSED: a wrong OTP (401) surfaces [OtpInvalidFailure] (NOT
/// "session expired"), a 429 surfaces [RateLimitedFailure]; nothing is wiped
/// unless the server confirms the delete.
///
/// The deps are optional named seams resolved LAZILY from the locator when
/// omitted (mirrors ProfileTabCubit) so tests inject fakes without a wired graph.
class AccountDeleteCubit extends Cubit<AccountDeleteState> {
  AccountDeleteCubit({
    ApiClient? api,
    SessionRepository? session,
    SecureTokenStore? tokenStore,
    ReauthSignal? reauthSignal,
  })  : _api = api,
        _session = session,
        _tokenStore = tokenStore,
        _reauthSignal = reauthSignal,
        super(const AccountDeleteState());

  final ApiClient? _api;
  final SessionRepository? _session;
  final SecureTokenStore? _tokenStore;
  final ReauthSignal? _reauthSignal;

  ApiClient get _apiClient => _api ?? locator<ApiClient>();
  SessionRepository get _sessionRepo => _session ?? locator<SessionRepository>();
  SecureTokenStore get _store => _tokenStore ?? locator<SecureTokenStore>();
  ReauthSignal get _reauth => _reauthSignal ?? locator<ReauthSignal>();

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

  /// Step 2: confirm with [otp]. On a 204 wipes local credentials + fires reauth.
  /// FAIL-CLOSED error mapping is delete-specific (401 → bad OTP, not re-login).
  Future<void> confirmDelete(String otp) async {
    final String? token = _tokenOrNull();
    if (token == null) {
      emit(const AccountDeleteState(
          status: AccountDeleteStatus.error, failure: UnauthorizedFailure()));
      return;
    }
    emit(state.copyWith(status: AccountDeleteStatus.confirming, failure: null));
    try {
      await _apiClient.confirmAccountDelete(authToken: token, otp: otp);
      await _wipeLocalCredentials();
      if (isClosed) return;
      emit(const AccountDeleteState(status: AccountDeleteStatus.deleted));
    } catch (error) {
      if (isClosed) return;
      emit(AccountDeleteState(
        status: AccountDeleteStatus.error,
        resendInSeconds: state.resendInSeconds,
        failure: _mapConfirmError(error),
      ));
    }
  }

  /// The account is gone server-side — clear the in-memory session + the secure
  /// store, then fire reauth so the app flips to logged-out.
  Future<void> _wipeLocalCredentials() async {
    try {
      await _store.clear();
    } catch (_) {
      // Best-effort: a store error must not block returning to login.
    }
    _sessionRepo.clear();
    _reauth.requireReauth();
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
