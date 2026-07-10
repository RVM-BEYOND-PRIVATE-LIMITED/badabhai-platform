import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Drives the payout-KYC state machine: loads the current [KycStatus] (none →
/// form, review → "under review", verified → confirmation) and submits the
/// PAN/bank form. The submission is never persisted/logged on the mock seam —
/// only the status transition (none → review) is kept.
class KycCubit extends Cubit<KycState> {
  KycCubit(this._api) : super(const KycState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: KycLoadStatus.loading));
    try {
      final KycStatus kyc = await _api.kycStatus();
      emit(KycState(status: KycLoadStatus.ready, kyc: kyc));
    } catch (_) {
      emit(state.copyWith(status: KycLoadStatus.error));
    }
  }

  /// Submit PAN/bank → flips the KYC status to `review`. Returns true on success
  /// so the screen can fire the confirmation toast.
  Future<bool> submit(KycSubmission submission) async {
    emit(state.copyWith(submitting: true));
    try {
      final KycStatus kyc = await _api.submitKyc(submission);
      emit(state.copyWith(submitting: false, kyc: kyc));
      return true;
    } catch (_) {
      emit(state.copyWith(submitting: false));
      return false;
    }
  }
}

enum KycLoadStatus { initial, loading, ready, error }

class KycState extends Equatable {
  const KycState({
    this.status = KycLoadStatus.initial,
    this.kyc = KycStatus.none,
    this.submitting = false,
  });

  final KycLoadStatus status;
  final KycStatus kyc;
  final bool submitting;

  KycState copyWith({
    KycLoadStatus? status,
    KycStatus? kyc,
    bool? submitting,
  }) {
    return KycState(
      status: status ?? this.status,
      kyc: kyc ?? this.kyc,
      submitting: submitting ?? this.submitting,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, kyc, submitting];
}
