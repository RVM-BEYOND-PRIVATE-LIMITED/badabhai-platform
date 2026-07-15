import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the payer's hiring-capacity allowance (`GET /payer/capacity`).
///
/// READ-ONLY. The tier upgrade (`POST /payer/capacity`) was REMOVED: it was a
/// MOCK payment against a client-side hardcoded price list, with no payment
/// provider behind it. A non-2xx read becomes an HONEST error state — never a
/// fabricated all-zero allowance.
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
