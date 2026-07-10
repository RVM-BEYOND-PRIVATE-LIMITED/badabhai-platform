import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the payer's hiring-capacity allowance (`GET /payer/capacity`) and buys
/// a higher tier (`POST /payer/capacity`, mock payment). A buy reports the
/// charged ₹ + any postings the higher allowance auto-resumed, then refetches
/// so the meter updates. A non-2xx becomes an HONEST neutral message.
class CapacityCubit extends Cubit<CapacityState> {
  CapacityCubit(this._api) : super(const CapacityState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: CapacityStatus.loading));
    try {
      final CapacityView capacity = await _api.fetchCapacity();
      emit(CapacityState(status: CapacityStatus.ready, capacity: capacity));
    } catch (_) {
      emit(state.copyWith(
        status: CapacityStatus.error,
        error: 'Could not load your hiring capacity. Retry in a moment.',
      ));
    }
  }

  /// Buy/upgrade to a catalog [tier] (`cap_5` | `cap_15`). Mock payment — the
  /// toast reports the charged ₹ + how many paused jobs resumed.
  Future<CapacityActionResult> buy(String tier) async {
    try {
      final CapacityPurchase r = await _api.buyCapacity(tier: tier);
      await load();
      final int? inr = r.finalInr;
      final int resumed = r.resumedPlanIds.length;
      final String head =
          inr == null ? 'Capacity raised.' : 'Capacity raised · ₹$inr charged.';
      final String tail = resumed == 0
          ? ''
          : ' $resumed job${resumed == 1 ? '' : 's'} resumed.';
      return CapacityActionResult.ok('$head$tail');
    } on PayerApiException {
      return const CapacityActionResult.fail(
        "Couldn't raise capacity right now.",
      );
    } catch (_) {
      return const CapacityActionResult.fail(
        'Network error. Check your connection.',
      );
    }
  }
}

/// The outcome of a one-shot capacity action — a success/neutral flag + a human
/// message the screen shows as a toast. Never carries PII.
class CapacityActionResult {
  const CapacityActionResult.ok(this.message) : success = true;
  const CapacityActionResult.fail(this.message) : success = false;

  final bool success;
  final String message;
}

enum CapacityStatus { initial, loading, ready, error }

class CapacityState extends Equatable {
  const CapacityState({
    this.status = CapacityStatus.initial,
    this.capacity,
    this.error,
  });

  final CapacityStatus status;
  final CapacityView? capacity;
  final String? error;

  CapacityState copyWith({
    CapacityStatus? status,
    CapacityView? capacity,
    String? error,
  }) {
    return CapacityState(
      status: status ?? this.status,
      capacity: capacity ?? this.capacity,
      error: error,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, capacity, error];
}
