import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/payer_api_client.dart';

/// App-wide credit balance. A single instance is shared so Home, Find, the
/// unlock dialog, and the Credits screen all read the same number (server-truth
/// in the real impl; in-memory in the mock).
///
/// State is the current balance; `null` before the first load AND after a failed
/// load — the balance is never faked to 0 (`fetchCredits` throws on a non-2xx),
/// so the UI renders "—" instead of claiming the payer has no credits.
class CreditsCubit extends Cubit<int?> {
  CreditsCubit(this._api) : super(null);

  final PayerApiClient _api;

  /// Re-reads the server-truth balance. A failure leaves the last known value
  /// (or `null` → "—") rather than emitting a fabricated 0.
  Future<void> load() async {
    try {
      emit(await _api.fetchCredits());
    } catch (_) {
      // Keep the prior value; the balance UI shows "—" while it is unknown.
    }
  }

  /// Spend 1 credit to unlock a candidate; emits the new balance.
  ///
  /// MOCK-ONLY (int-keyed): the real flow goes through `FindCubit.unlockApplicant`
  /// → `POST /payer/unlocks` with the opaque worker UUID, then re-reads [load].
  Future<void> unlock(int candidateId) async {
    emit(await _api.unlockCandidate(candidateId));
  }
}
