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
      // The per-unlock history (`GET /payer/unlocks`) is a SEPARATE, best-effort
      // section — a blip on it must not blank the balance + credit ledger, which
      // are the primary content. Fall back to an empty list on any error.
      List<LedgerEntry> unlockLedger;
      try {
        unlockLedger = await _api.fetchLedger();
      } catch (_) {
        unlockLedger = const <LedgerEntry>[];
      }
      emit(
        CreditsScreenState(
          status: CreditsScreenStatus.ready,
          ledger: ledger,
          unlockLedger: unlockLedger,
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
    this.unlockLedger = const <LedgerEntry>[],
    this.balance,
  });

  final CreditsScreenStatus status;

  /// The credit-ACCOUNT ledger (`GET /payer/credits/ledger`) — pack purchases,
  /// unlock debits, grants, refunds.
  final List<LedgerEntry> ledger;

  /// The per-UNLOCK history (`GET /payer/unlocks`) — one row per unlock. Loaded
  /// best-effort, so it may be empty even when the credit ledger is not.
  final List<LedgerEntry> unlockLedger;

  /// The REAL balance (`null` until first load).
  final int? balance;

  CreditsScreenState copyWith({
    CreditsScreenStatus? status,
    List<LedgerEntry>? ledger,
    List<LedgerEntry>? unlockLedger,
    int? balance,
  }) {
    return CreditsScreenState(
      status: status ?? this.status,
      ledger: ledger ?? this.ledger,
      unlockLedger: unlockLedger ?? this.unlockLedger,
      balance: balance ?? this.balance,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, ledger, unlockLedger, balance];
}
