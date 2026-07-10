import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the agency Earn-hub: the saffron summary card numbers + the current
/// payout-KYC status (so the KYC nav card can show its badge). Agency-only.
class EarnHubCubit extends Cubit<EarnHubState> {
  EarnHubCubit(this._api) : super(const EarnHubState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: EarnHubStatus.loading));
    try {
      final EarnSummary summary = await _api.fetchEarnSummary();
      final KycStatus kyc = await _api.kycStatus();
      emit(EarnHubState(
        status: EarnHubStatus.ready,
        summary: summary,
        kyc: kyc,
      ));
    } catch (_) {
      emit(state.copyWith(status: EarnHubStatus.error));
    }
  }
}

enum EarnHubStatus { initial, loading, ready, error }

class EarnHubState extends Equatable {
  const EarnHubState({
    this.status = EarnHubStatus.initial,
    this.summary,
    this.kyc = KycStatus.none,
  });

  final EarnHubStatus status;
  final EarnSummary? summary;
  final KycStatus kyc;

  EarnHubState copyWith({
    EarnHubStatus? status,
    EarnSummary? summary,
    KycStatus? kyc,
  }) {
    return EarnHubState(
      status: status ?? this.status,
      summary: summary ?? this.summary,
      kyc: kyc ?? this.kyc,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, summary, kyc];
}
