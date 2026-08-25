import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the agency's OWN payout request history (`GET /payer/agency/payouts`).
/// AGENT-only AND FLAG-GATED: a neutral 404 (`AGENCY_PAYOUTS_ENABLED` off) maps
/// to [AgencyPayoutsStatus.unavailable] ("not available yet"), a company
/// session's 403 to [AgencyPayoutsStatus.forbidden] — never a crash or a
/// fabricated empty history shown as real. An empty-but-OK load is its own state.
class AgencyPayoutsCubit extends Cubit<AgencyPayoutsState> {
  AgencyPayoutsCubit(this._api) : super(const AgencyPayoutsState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: AgencyPayoutsStatus.loading));
    try {
      final List<AgencyPayout> payouts = await _api.fetchAgencyPayouts();
      emit(AgencyPayoutsState(
        status: AgencyPayoutsStatus.ready,
        payouts: payouts,
      ));
    } on PayerApiException catch (e) {
      emit(state.copyWith(status: _statusFor(e.statusCode)));
    } catch (_) {
      emit(state.copyWith(status: AgencyPayoutsStatus.error));
    }
  }

  static AgencyPayoutsStatus _statusFor(int code) {
    switch (code) {
      case 404:
        return AgencyPayoutsStatus.unavailable;
      case 403:
        return AgencyPayoutsStatus.forbidden;
      default:
        return AgencyPayoutsStatus.error;
    }
  }
}

enum AgencyPayoutsStatus {
  initial,
  loading,
  ready,
  empty,

  /// The launch flag is OFF (neutral 404) — show "not available yet".
  unavailable,
  forbidden,
  error,
}

class AgencyPayoutsState extends Equatable {
  const AgencyPayoutsState({
    this.status = AgencyPayoutsStatus.initial,
    this.payouts = const <AgencyPayout>[],
  });

  final AgencyPayoutsStatus status;
  final List<AgencyPayout> payouts;

  /// A successful load with no rows is its own view (invite the agent to earn).
  AgencyPayoutsStatus get resolvedStatus =>
      status == AgencyPayoutsStatus.ready && payouts.isEmpty
          ? AgencyPayoutsStatus.empty
          : status;

  AgencyPayoutsState copyWith({
    AgencyPayoutsStatus? status,
    List<AgencyPayout>? payouts,
  }) {
    return AgencyPayoutsState(
      status: status ?? this.status,
      payouts: payouts ?? this.payouts,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, payouts];
}
