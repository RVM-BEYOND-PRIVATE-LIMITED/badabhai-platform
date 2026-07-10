import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the masked rows of workers this agency introduced (window countdowns +
/// earned ₹). DESIGN-ONLY data on the mock seam (no backend endpoint yet).
class ReferredCubit extends Cubit<ReferredState> {
  ReferredCubit(this._api) : super(const ReferredState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: ReferredStatus.loading));
    try {
      final List<ReferredWorker> workers = await _api.fetchReferredWorkers();
      emit(ReferredState(status: ReferredStatus.ready, workers: workers));
    } catch (_) {
      emit(state.copyWith(status: ReferredStatus.error));
    }
  }
}

enum ReferredStatus { initial, loading, ready, error }

class ReferredState extends Equatable {
  const ReferredState({
    this.status = ReferredStatus.initial,
    this.workers = const <ReferredWorker>[],
  });

  final ReferredStatus status;
  final List<ReferredWorker> workers;

  ReferredState copyWith({
    ReferredStatus? status,
    List<ReferredWorker>? workers,
  }) {
    return ReferredState(
      status: status ?? this.status,
      workers: workers ?? this.workers,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, workers];
}
