import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/payer_api_client.dart';

/// App-wide credit balance state. `balance` is `null` before the first
/// successful load; `error` flags a failed refresh (transport/5xx).
///
/// FAST-FOLLOW (#189 merge review): a fetch failure must NEVER masquerade as a
/// real "0 credits" — on error the last-known balance is kept and `error` is
/// set, so the Home stat and the Find unlock-dialog math render an honest
/// unknown ('—') instead of 0 during an outage.
class CreditsState extends Equatable {
  const CreditsState({this.balance, this.error = false});

  /// Server-truth balance, or `null` when never loaded / unknown.
  final int? balance;

  /// True when the LAST refresh failed — the UI shows '—' + a retry affordance.
  final bool error;

  @override
  List<Object?> get props => <Object?>[balance, error];
}

/// App-wide credit balance. A single instance is shared so Home, Find, the
/// unlock dialog, and the Credits screen all read the same number (server-truth
/// in the real impl; in-memory in the mock).
///
/// READ + spend only: the buy-credits surface was stripped by the production
/// hardening pass (#233 — no payment provider behind it), so there is no buy()
/// here.
class CreditsCubit extends Cubit<CreditsState> {
  CreditsCubit(this._api) : super(const CreditsState());

  final PayerApiClient _api;

  /// Refresh from server truth via the GUARDED [PayerApiClient.fetchCreditBalance]
  /// (throws on any non-2xx). On failure: keep the last-known balance, set
  /// `error` — never emit a fabricated 0.
  Future<void> load() async {
    try {
      final int balance = await _api.fetchCreditBalance();
      emit(CreditsState(balance: balance));
    } catch (_) {
      emit(CreditsState(balance: state.balance, error: true));
    }
  }

  /// Drops the balance back to unknown (#369).
  ///
  /// This cubit is an app-wide lazySingleton, so unlike every per-mount cubit it
  /// SURVIVES sign-out. Without this, the signed-out payer's balance stayed in
  /// state and the next payer's Home rendered it as their own — and because
  /// [load]'s failure path deliberately keeps the last-known balance, a failed
  /// first fetch for the new account left the PREVIOUS account's number on
  /// screen indefinitely. On a shared office device that is one payer reading
  /// another's balance. Sign-out must therefore reset to the honest '—'.
  void reset() => emit(const CreditsState());

  /// Spend 1 credit to unlock a candidate, then re-read server truth through
  /// the guarded [load] — the value returned by `unlockCandidate` is
  /// deliberately NOT trusted (its internal credits re-read can mask a
  /// failure as 0).
  ///
  /// MOCK-ONLY (int-keyed): the real flow goes through `FindCubit.unlockApplicant`
  /// → `POST /payer/unlocks` with the opaque worker UUID, then re-reads [load].
  Future<void> unlock(int candidateId) async {
    try {
      await _api.unlockCandidate(candidateId);
    } catch (_) {
      emit(CreditsState(balance: state.balance, error: true));
      return;
    }
    await load();
  }
}
