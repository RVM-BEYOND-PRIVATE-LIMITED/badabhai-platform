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
      // Packs are best-effort too: a pricing-catalog blip hides the buy section
      // but must not fail the whole screen (balance + ledger stay).
      List<CreditPack> packs;
      try {
        packs = await _api.fetchCreditPacks();
      } catch (_) {
        packs = const <CreditPack>[];
      }
      if (isClosed) return; // screen popped mid-load — emit would throw StateError
      emit(
        CreditsScreenState(
          status: CreditsScreenStatus.ready,
          ledger: ledger,
          unlockLedger: unlockLedger,
          balance: balance,
          packs: packs,
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
