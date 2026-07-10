import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/payer_account_api.dart';

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
    } catch (_) {
      emit(state.copyWith(
        status: AccountStatus.error,
        error: 'Could not load your account. Retry when you have a connection.',
      ));
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
    } catch (_) {
      emit(state.copyWith(
        status: AccountStatus.error,
        error: 'Could not save your changes. Check the details and retry.',
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
