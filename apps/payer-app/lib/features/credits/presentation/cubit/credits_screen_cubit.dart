import 'dart:math';

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

  final Random _rng = Random();

  /// The idempotency key for the CURRENT in-flight-or-failed purchase intent,
  /// plus the pack it belongs to. Minted once per intent and REUSED across a
  /// safe retry of the SAME pack after a failure — so the server dedupes a
  /// re-tap into a replay, never a second grant. Cleared on a confirmed success;
  /// a NEW pack (or a fresh intent after success) mints a new key.
  String? _pendingKey;
  String? _pendingKeyPack;

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

  /// Buy the pack with [code]. On success the new balance is applied and the
  /// ledger re-read so the purchase row shows.
  ///
  /// SAFE RETRY: every attempt carries a stable idempotency key so a re-tap after
  /// a timeout can never double-grant. On a FAILURE the server may already have
  /// committed the grant (a timeout / 409 / dropped socket AFTER the write), so
  /// instead of a blind `purchaseFailed` we RE-READ the balance: if it went up
  /// the grant landed and we report success; if not, we keep the pending key so
  /// the next tap of the SAME pack replays it (server dedupes) and surface the
  /// honest, retryable failure.
  Future<void> buyPack(String code) async {
    if (state.purchasing != null) return; // one purchase at a time

    // Snapshot the balance BEFORE the write — the reconciliation baseline.
    final int? preBalance = state.balance;

    // Reuse the pending key ONLY for a retry of the same pack; otherwise this is
    // a fresh intent (first buy, a different pack, or a buy after a clean
    // success) and gets a new key.
    if (_pendingKey == null || _pendingKeyPack != code) {
      _pendingKey = _mintIdempotencyKey(code);
      _pendingKeyPack = code;
    }
    final String key = _pendingKey!;

    emit(state.copyWith(
        purchasing: code, purchaseFailed: false, purchased: false));
    try {
      final int balance = await _api.buyCreditPack(code, idempotencyKey: key);
      await _applyPurchased(balance);
    } catch (_) {
      // The write threw — but a timeout / 409 (in-flight) / dropped socket can
      // hide a grant the server DID commit. Reconcile against the real balance
      // before declaring failure (a 409 is handled the same as "not yet up").
      await _reconcileAfterFailedBuy(preBalance);
    }
  }

  /// A confirmed purchase: re-read the ledger (best-effort), clear the pending
  /// key, and emit the applied balance + the one-shot `purchased` cue.
  Future<void> _applyPurchased(int balance) async {
    // Re-read the ledger so the pack-purchase row appears; keep the last ledger
    // if that read blips (the balance is authoritative and already updated).
    List<LedgerEntry> ledger;
    try {
      ledger = await _api.fetchCreditLedger();
    } catch (_) {
      ledger = state.ledger;
    }
    if (isClosed) return;
    _pendingKey = null;
    _pendingKeyPack = null;
    emit(state.copyWith(
      balance: balance,
      ledger: ledger,
      clearPurchasing: true,
      purchased: true,
    ));
  }

  /// Runs after `buyCreditPack` threw. Re-reads the balance: if it INCREASED vs
  /// [preBalance] the grant committed despite the error → treat as success
  /// (no double-grant). Otherwise keep the pending key for a safe retry and
  /// surface `purchaseFailed`.
  Future<void> _reconcileAfterFailedBuy(int? preBalance) async {
    int? postBalance;
    try {
      postBalance = await _api.fetchCreditBalance();
    } catch (_) {
      postBalance = null; // can't prove a grant → fall through to failure
    }
    if (isClosed) return;

    final bool committed = preBalance != null &&
        postBalance != null &&
        postBalance > preBalance;
    if (committed) {
      await _applyPurchased(postBalance);
      return;
    }

    // Not committed (or unprovable): keep _pendingKey so the next tap of this
    // pack reuses it and the server dedupes. Balance/ledger untouched.
    emit(state.copyWith(clearPurchasing: true, purchaseFailed: true));
  }

  /// A PII-free, single-purchase idempotency token: a monotonic timestamp, the
  /// pack code, and a 32-bit random tail. No `uuid` package (removed in #1090).
  String _mintIdempotencyKey(String code) =>
      '${DateTime.now().microsecondsSinceEpoch}-$code-${_rng.nextInt(1 << 32)}';
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
