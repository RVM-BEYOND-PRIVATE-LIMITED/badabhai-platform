import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the Buy-credits screen: the pack catalogue (config-only), the REAL
/// balance (`GET /payer/credits`), and the REAL credit ledger
/// (`GET /payer/credits/ledger`). [buyPack] posts a real pack purchase
/// (`POST /payer/credits`), then refetches balance + ledger.
class CreditsScreenCubit extends Cubit<CreditsScreenState> {
  CreditsScreenCubit(this._api) : super(const CreditsScreenState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: CreditsScreenStatus.loading));
    try {
      final List<CreditPack> packs = await _api.fetchCreditPacks();
      final int balance = await _api.fetchCreditBalance();
      final List<LedgerEntry> ledger = await _api.fetchCreditLedger();
      emit(
        CreditsScreenState(
          status: CreditsScreenStatus.ready,
          packs: packs,
          ledger: ledger,
          balance: balance,
        ),
      );
    } catch (_) {
      emit(state.copyWith(status: CreditsScreenStatus.error));
    }
  }

  /// Buys [pack] via its server code, then refreshes balance + ledger from
  /// server-truth. Returns `null` on success or an honest error message.
  Future<String?> buyPack(CreditPack pack) async {
    final String code = pack.code ?? 'pack_${pack.count}';
    try {
      final int balance = await _api.buyCreditPack(packCode: code);
      final List<LedgerEntry> ledger = await _api.fetchCreditLedger();
      emit(state.copyWith(balance: balance, ledger: ledger));
      return null;
    } on PayerApiException {
      return 'Could not add credits. Please try again.';
    } catch (_) {
      return 'Network error. Check your connection.';
    }
  }
}

enum CreditsScreenStatus { initial, loading, ready, error }

class CreditsScreenState extends Equatable {
  const CreditsScreenState({
    this.status = CreditsScreenStatus.initial,
    this.packs = const <CreditPack>[],
    this.ledger = const <LedgerEntry>[],
    this.balance,
  });

  final CreditsScreenStatus status;
  final List<CreditPack> packs;
  final List<LedgerEntry> ledger;

  /// The REAL balance (`null` until first load).
  final int? balance;

  CreditsScreenState copyWith({
    CreditsScreenStatus? status,
    List<CreditPack>? packs,
    List<LedgerEntry>? ledger,
    int? balance,
  }) {
    return CreditsScreenState(
      status: status ?? this.status,
      packs: packs ?? this.packs,
      ledger: ledger ?? this.ledger,
      balance: balance ?? this.balance,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, packs, ledger, balance];
}
