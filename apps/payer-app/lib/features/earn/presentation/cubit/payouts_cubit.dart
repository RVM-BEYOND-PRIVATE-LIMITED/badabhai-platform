import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the Earnings & payouts screen: the aggregate summary + settled history.
/// DESIGN-ONLY data on the mock seam (no backend endpoint yet).
class PayoutsCubit extends Cubit<PayoutsState> {
  PayoutsCubit(this._api) : super(const PayoutsState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: PayoutsStatus.loading));
    try {
      final PayoutSummary summary = await _api.fetchPayoutSummary();
      final List<PayoutEntry> history = await _api.fetchPayouts();
      emit(PayoutsState(
        status: PayoutsStatus.ready,
        summary: summary,
        history: history,
      ));
    } catch (_) {
      emit(state.copyWith(status: PayoutsStatus.error));
    }
  }
}

enum PayoutsStatus { initial, loading, ready, error }

class PayoutsState extends Equatable {
  const PayoutsState({
    this.status = PayoutsStatus.initial,
    this.summary,
    this.history = const <PayoutEntry>[],
  });

  final PayoutsStatus status;
  final PayoutSummary? summary;
  final List<PayoutEntry> history;

  PayoutsState copyWith({
    PayoutsStatus? status,
    PayoutSummary? summary,
    List<PayoutEntry>? history,
  }) {
    return PayoutsState(
      status: status ?? this.status,
      summary: summary ?? this.summary,
      history: history ?? this.history,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, summary, history];
}
