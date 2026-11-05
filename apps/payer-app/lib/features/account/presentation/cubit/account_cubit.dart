import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/payer_account_api.dart';
import '../../../../core/error/api_error_copy.dart';

/// Loads and edits the signed-in payer's account via `GET/PATCH /payer/me`.
/// PII-light by construction: the model only ever carries `phoneLast4`, never a
/// full phone. Errors surface a real reason (not a generic "check internet").
class AccountCubit extends Cubit<AccountState> {
  AccountCubit(this._api) : super(const AccountState());

  final PayerAccountApi _api;

  /// `GET /payer/me`.
  Future<void> load() async {
    emit(state.copyWith(status: AccountStatus.loading, clearError: true));
    try {
      final PayerMe me = await _api.fetchMe();
      emit(AccountState(status: AccountStatus.ready, me: me));
    } catch (e) {
      // Name the REAL reason (offline vs server vs expired session), not a flat
      // "check your connection" that misleads on a 5xx.
      emit(state.copyWith(
        status: AccountStatus.error,
        error: ApiErrorCopy.forError(e, context: 'account.load'),
      ));
    }
  }

  /// TEST-ONLY (see kEnablePayerTestDelete): immediately delete the signed-in
  /// payer's own account. Returns `true` only when the server confirmed it; on
  /// ANY failure — the seam-disabled 404, a 401, a transport error, or a missing
  /// session — returns `false` and never throws, so the screen can branch on it.
  ///
  /// The local teardown (revoke best-effort + wipe the bearer + leave for
  /// Login) is the caller's [onSignOut], exactly the sign-out path the Account
  /// screen already owns.
  Future<bool> deleteAccountForTest() async {
    try {
      await _api.deleteAccountImmediatelyForTest();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// `PATCH /payer/me` with ONLY the changed fields. A no-op (nothing changed)
  /// short-circuits so we never send an empty body (a 400 server-side).
  Future<void> updateMe({String? orgName, String? phone}) async {
    if (orgName == null && phone == null) return;
    emit(state.copyWith(status: AccountStatus.saving, clearError: true));
    try {
      final PayerMe me = await _api.updateMe(orgName: orgName, phone: phone);
      emit(AccountState(status: AccountStatus.ready, me: me));
    } catch (e) {
      emit(state.copyWith(
        status: AccountStatus.error,
        error: ApiErrorCopy.forError(e, context: 'account.save'),
      ));
    }
  }
}

enum AccountStatus { initial, loading, ready, saving, error }

class AccountState extends Equatable {
  const AccountState({
    this.status = AccountStatus.initial,
    this.me,
    this.error,
  });

  final AccountStatus status;
  final PayerMe? me;
  final String? error;

  bool get isBusy =>
      status == AccountStatus.loading || status == AccountStatus.saving;

  AccountState copyWith({
    AccountStatus? status,
    PayerMe? me,
    String? error,
    bool clearError = false,
  }) {
    return AccountState(
      status: status ?? this.status,
      me: me ?? this.me,
      error: clearError ? null : (error ?? this.error),
    );
  }

  @override
  List<Object?> get props => <Object?>[status, me, error];
}
