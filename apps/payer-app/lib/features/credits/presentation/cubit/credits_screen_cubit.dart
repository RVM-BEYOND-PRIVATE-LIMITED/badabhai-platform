import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/error/payer_failure.dart';

/// Loads the Credits screen: the REAL balance (`GET /payer/credits`), the REAL
/// credit ledger (`GET /payer/credits/ledger`), and the buyable packs
/// (`GET /payer/pricing/catalog`); [buyPack] runs the MOCK purchase
/// (`POST /payer/credits`).
class CreditsScreenCubit extends Cubit<CreditsScreenState> {
  CreditsScreenCubit(this._api) : super(const CreditsScreenState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: CreditsScreenStatus.loading));
    try {
      // The four reads are independent, so fire them CONCURRENTLY — on a 2G/3G
      // link this bounds first paint by one round trip instead of four in series.
      // balance + ledger are primary (a throw fails the screen via Future.wait);
      // the per-unlock history (`GET /payer/unlocks`) and the pricing catalog are
      // best-effort — a blip there falls back to empty without blanking the screen.
      final List<Object> results = await Future.wait(<Future<Object>>[
        _api.fetchCreditBalance(),
        _api.fetchCreditLedger(),
        _api.fetchLedger().onError((_, __) => const <LedgerEntry>[]),
        _api.fetchCreditPacks().onError((_, __) => const <CreditPack>[]),
      ]);
      if (isClosed) return; // screen popped mid-load — emit would throw StateError
      emit(
        CreditsScreenState(
          status: CreditsScreenStatus.ready,
          balance: results[0] as int,
          ledger: results[1] as List<LedgerEntry>,
          unlockLedger: results[2] as List<LedgerEntry>,
          packs: results[3] as List<CreditPack>,
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

  /// Buy the pack with [code] (MOCK). On success the new balance is applied and
  /// the ledger re-read so the purchase row shows; a failure surfaces via
  /// [CreditsScreenState.purchaseFailed] without touching the balance/ledger.
  Future<void> buyPack(String code) async {
    if (state.purchasing != null) return; // one purchase at a time
    emit(state.copyWith(
        purchasing: code, purchaseFailed: false, purchased: false));
    try {
      final int balance = await _api.buyCreditPack(code);
      // Re-read the ledger so the pack-purchase row appears; keep the last ledger
      // if that read blips (the balance is authoritative and already updated).
      List<LedgerEntry> ledger;
      try {
        ledger = await _api.fetchCreditLedger();
      } catch (_) {
        ledger = state.ledger;
      }
      if (isClosed) return;
      emit(state.copyWith(
        balance: balance,
        ledger: ledger,
        clearPurchasing: true,
        purchased: true,
      ));
    } catch (_) {
      if (isClosed) return;
      emit(state.copyWith(clearPurchasing: true, purchaseFailed: true));
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
    this.packs = const <CreditPack>[],
    this.purchasing,
    this.purchaseFailed = false,
    this.purchased = false,
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

  /// The buyable packs from the server pricing catalog; empty when none / a blip.
  final List<CreditPack> packs;

  /// The pack code currently being bought (its card shows a spinner); null when
  /// idle.
  final String? purchasing;

  /// The last purchase attempt failed — the UI shows an honest retry, transient.
  final bool purchaseFailed;

  /// A purchase just succeeded — drives the one-shot "credits added" cue.
  final bool purchased;

  CreditsScreenState copyWith({
    CreditsScreenStatus? status,
    List<LedgerEntry>? ledger,
    List<LedgerEntry>? unlockLedger,
    int? balance,
    List<CreditPack>? packs,
    String? purchasing,
    bool clearPurchasing = false,
    bool? purchaseFailed,
    bool? purchased,
    PayerFailure? failure,
  }) {
    return CreditsScreenState(
      status: status ?? this.status,
      ledger: ledger ?? this.ledger,
      unlockLedger: unlockLedger ?? this.unlockLedger,
      balance: balance ?? this.balance,
      packs: packs ?? this.packs,
      purchasing: clearPurchasing ? null : (purchasing ?? this.purchasing),
      purchaseFailed: purchaseFailed ?? this.purchaseFailed,
      purchased: purchased ?? this.purchased,
      failure: failure ?? this.failure,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        ledger,
        unlockLedger,
        balance,
        packs,
        purchasing,
        purchaseFailed,
        purchased,
        failure,
      ];
}
