import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the Credits screen: the REAL balance (`GET /payer/credits`) and the
/// REAL credit ledger (`GET /payer/credits/ledger`).
///
/// READ-ONLY. The pack catalogue (config-only, no endpoint — its prices were
/// hardcoded client-side and contradicted the server pricing catalog) and the
/// purchase action were REMOVED: there is no payment provider behind them.
class CreditsScreenCubit extends Cubit<CreditsScreenState> {
  CreditsScreenCubit(this._api) : super(const CreditsScreenState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: CreditsScreenStatus.loading));
    try {
      final int balance = await _api.fetchCreditBalance();
      final List<LedgerEntry> ledger = await _api.fetchCreditLedger();
      emit(
        CreditsScreenState(
          status: CreditsScreenStatus.ready,
          ledger: ledger,
          balance: balance,
        ),
      );
    } catch (_) {
      emit(state.copyWith(status: CreditsScreenStatus.error));
    }
  }
}

enum CreditsScreenStatus { initial, loading, ready, error }

class CreditsScreenState extends Equatable {
  const CreditsScreenState({
    this.status = CreditsScreenStatus.initial,
    this.ledger = const <LedgerEntry>[],
    this.balance,
  });

  final CreditsScreenStatus status;
  final List<LedgerEntry> ledger;

  /// The REAL balance (`null` until first load).
  final int? balance;

  CreditsScreenState copyWith({
    CreditsScreenStatus? status,
    List<LedgerEntry>? ledger,
    int? balance,
  }) {
    return CreditsScreenState(
      status: status ?? this.status,
      ledger: ledger ?? this.ledger,
      balance: balance ?? this.balance,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, ledger, balance];
}
