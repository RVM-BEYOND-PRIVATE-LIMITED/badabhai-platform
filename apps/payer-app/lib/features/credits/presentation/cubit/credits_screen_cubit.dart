import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/error/payer_failure.dart';

/// Loads the Credits screen: the REAL balance (`GET /payer/credits`), the REAL
/// credit ledger (`GET /payer/credits/ledger`), and the per-unlock history
/// (`GET /payer/unlocks`).
///
/// READ-ONLY. There is NO in-app purchase here: selling a digital entitlement
/// from inside a store-distributed app is exactly what App Store / Play Store
/// IAP policy covers, and the mobile-payments rule bars it outright. Credit packs
/// are bought on the payer WEB portal, so this cubit only REPORTS what the server
/// says the payer has and has spent.
class CreditsScreenCubit extends Cubit<CreditsScreenState> {
  CreditsScreenCubit(this._api) : super(const CreditsScreenState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: CreditsScreenStatus.loading));
    try {
      // The three reads are independent, so fire them CONCURRENTLY — on a 2G/3G
      // link this bounds first paint by one round trip instead of three in
      // series. balance + ledger are primary (a throw fails the screen via
      // Future.wait); the per-unlock history (`GET /payer/unlocks`) is
      // best-effort — a blip there falls back to empty without blanking the screen.
      final List<Object> results = await Future.wait(<Future<Object>>[
        _api.fetchCreditBalance(),
        _api.fetchCreditLedger(),
        _api.fetchLedger().onError((_, __) => const <LedgerEntry>[]),
      ]);
      if (isClosed) return; // screen popped mid-load — emit would throw StateError
      emit(
        CreditsScreenState(
          status: CreditsScreenStatus.ready,
          balance: results[0] as int,
          ledger: results[1] as List<LedgerEntry>,
          unlockLedger: results[2] as List<LedgerEntry>,
        ),
      );
    } catch (e) {
      if (isClosed) return;
      emit(state.copyWith(
        status: CreditsScreenStatus.error,
        failure: PayerFailure.from(e),
      ));
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
    this.failure,
  });

  final CreditsScreenStatus status;

  /// The classified reason [load] failed — drives the honest error copy. Null
  /// unless [status] is [CreditsScreenStatus.error].
  final PayerFailure? failure;

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
    PayerFailure? failure,
  }) {
    return CreditsScreenState(
      status: status ?? this.status,
      ledger: ledger ?? this.ledger,
      unlockLedger: unlockLedger ?? this.unlockLedger,
      balance: balance ?? this.balance,
      failure: failure ?? this.failure,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        ledger,
        unlockLedger,
        balance,
        failure,
      ];
}
