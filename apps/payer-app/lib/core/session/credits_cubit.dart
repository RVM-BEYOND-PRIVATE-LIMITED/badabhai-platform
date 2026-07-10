import 'package:flutter_bloc/flutter_bloc.dart';

import '../data/payer_api_client.dart';

/// App-wide credit balance. A single instance is shared so Home, Find, the
/// unlock dialog, and Buy-credits all read/write the same number (server-truth
/// in the real impl; in-memory in the mock).
///
/// State is the current balance; `null` before the first load.
class CreditsCubit extends Cubit<int?> {
  CreditsCubit(this._api) : super(null);

  final PayerApiClient _api;

  Future<void> load() async => emit(await _api.fetchCredits());

  /// Spend 1 credit to unlock a candidate; emits the new balance.
  Future<void> unlock(int candidateId) async {
    emit(await _api.unlockCandidate(candidateId));
  }

  /// Add a pack's worth of credits; emits the new balance.
  Future<void> buy(int count) async {
    emit(await _api.buyCredits(count));
  }
}
