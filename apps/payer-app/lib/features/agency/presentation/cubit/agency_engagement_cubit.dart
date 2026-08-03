import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the agency's FACELESS referred-worker funnel
/// (`GET /payer/agency/workers`, AGENT-only). Each row is an opaque [AgencyWorker]
/// ref + coarse progress/engagement counts — never a name/phone.
///
/// A company session's 403 and a rate-cap 429 are surfaced as DISTINCT honest
/// states (agent-only / try-again), never a fabricated empty funnel; any other
/// non-2xx is the generic retry error. An empty-but-OK load is its own state so
/// the UI can invite the agent to share their link rather than look broken.
class AgencyEngagementCubit extends Cubit<AgencyEngagementState> {
  AgencyEngagementCubit(this._api) : super(const AgencyEngagementState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: AgencyEngagementStatus.loading));
    try {
      final List<AgencyWorker> workers = await _api.fetchReferredWorkers();
      emit(AgencyEngagementState(
        status: AgencyEngagementStatus.ready,
        workers: workers,
      ));
    } on PayerApiException catch (e) {
      emit(state.copyWith(status: _statusFor(e.statusCode)));
    } catch (_) {
      emit(state.copyWith(status: AgencyEngagementStatus.error));
    }
  }

  static AgencyEngagementStatus _statusFor(int code) {
    switch (code) {
      case 403:
        return AgencyEngagementStatus.forbidden;
      case 429:
        return AgencyEngagementStatus.rateLimited;
      default:
        return AgencyEngagementStatus.error;
    }
  }
}

enum AgencyEngagementStatus {
  initial,
  loading,
  ready,
  empty,
  forbidden,
  rateLimited,
  error,
}

class AgencyEngagementState extends Equatable {
  const AgencyEngagementState({
    this.status = AgencyEngagementStatus.initial,
    this.workers = const <AgencyWorker>[],
  });

  final AgencyEngagementStatus status;
  final List<AgencyWorker> workers;

  /// A successful load that returned no funnel rows — treated as its own view.
  AgencyEngagementStatus get resolvedStatus =>
      status == AgencyEngagementStatus.ready && workers.isEmpty
          ? AgencyEngagementStatus.empty
          : status;

  AgencyEngagementState copyWith({
    AgencyEngagementStatus? status,
    List<AgencyWorker>? workers,
  }) {
    return AgencyEngagementState(
      status: status ?? this.status,
      workers: workers ?? this.workers,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, workers];
}
