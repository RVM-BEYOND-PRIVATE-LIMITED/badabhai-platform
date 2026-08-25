import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the agency's masked KYC status (`GET /payer/agency/kyc`) and submits a
/// new/replacement KYC (`POST /payer/agency/kyc`). AGENT-only AND FLAG-GATED: a
/// neutral 404 (`AGENCY_PAYOUTS_ENABLED` off) maps to
/// [AgencyKycStatus.unavailable] ("not available yet"), a company session's 403
/// to [AgencyKycStatus.forbidden] — never a crash or a generic error.
///
/// The raw PAN / bank / IFSC never round-trip: the server encrypts them at rest
/// and only ever returns the last-4, so [AgencyKycView] carries no full value.
class AgencyKycCubit extends Cubit<AgencyKycState> {
  AgencyKycCubit(this._api) : super(const AgencyKycState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: AgencyKycStatus.loading));
    try {
      final AgencyKycView kyc = await _api.fetchAgencyKyc();
      emit(AgencyKycState(status: AgencyKycStatus.ready, kyc: kyc));
    } on PayerApiException catch (e) {
      emit(state.copyWith(status: _statusFor(e.statusCode)));
    } catch (_) {
      emit(state.copyWith(status: AgencyKycStatus.error));
    }
  }

  /// Submit (or replace) the KYC. Returns a [KycSubmitResult] the screen shows
  /// as a toast; on success it updates the in-state view (masked). A 400 (bad
  /// PAN/IFSC/account) / 409 (a PAN already backing another agency) surface as
  /// honest, no-oracle messages. Guarded by [state.submitting].
  Future<KycSubmitResult> submit({
    required String pan,
    required String bankAccount,
    required String ifsc,
    required String accountHolderName,
  }) async {
    if (state.submitting) return const KycSubmitResult.fail('Please wait…');
    emit(state.copyWith(submitting: true));
    try {
      final AgencyKycView kyc = await _api.submitAgencyKyc(
        pan: pan,
        bankAccount: bankAccount,
        ifsc: ifsc,
        accountHolderName: accountHolderName,
      );
      emit(AgencyKycState(
        status: AgencyKycStatus.ready,
        kyc: kyc,
        submitting: false,
      ));
      return const KycSubmitResult.ok(
        'KYC submitted — we will verify your details shortly.',
      );
    } on PayerApiException catch (e) {
      emit(state.copyWith(submitting: false));
      switch (e.statusCode) {
        case 400:
          return const KycSubmitResult.fail(
            'Please check your PAN, account number and IFSC and try again.',
          );
        case 409:
          // No-oracle: never "PAN X is taken" — a neutral could-not-save.
          return const KycSubmitResult.fail(
            'These details could not be saved. Please check them and retry.',
          );
        case 404:
          emit(state.copyWith(status: AgencyKycStatus.unavailable));
          return const KycSubmitResult.fail('KYC is not available yet.');
        case 403:
          emit(state.copyWith(status: AgencyKycStatus.forbidden));
          return const KycSubmitResult.fail(
            'This is only available for agency accounts.',
          );
        default:
          return const KycSubmitResult.fail(
            'Could not submit. Please try again.',
          );
      }
    } catch (_) {
      emit(state.copyWith(submitting: false));
      return const KycSubmitResult.fail(
        'Network error. Check your connection.',
      );
    }
  }

  static AgencyKycStatus _statusFor(int code) {
    switch (code) {
      case 404:
        return AgencyKycStatus.unavailable;
      case 403:
        return AgencyKycStatus.forbidden;
      default:
        return AgencyKycStatus.error;
    }
  }
}

/// The outcome of a KYC submit — a success flag + a human message. No PII, no
/// raw code.
class KycSubmitResult {
  const KycSubmitResult.ok(this.message) : success = true;
  const KycSubmitResult.fail(this.message) : success = false;

  final bool success;
  final String message;
}

enum AgencyKycStatus {
  initial,
  loading,
  ready,

  /// The launch flag is OFF (neutral 404) — show "not available yet".
  unavailable,
  forbidden,
  error,
}

class AgencyKycState extends Equatable {
  const AgencyKycState({
    this.status = AgencyKycStatus.initial,
    this.kyc,
    this.submitting = false,
  });

  final AgencyKycStatus status;
  final AgencyKycView? kyc;

  /// True while a submit is in flight (disables the submit button).
  final bool submitting;

  AgencyKycState copyWith({
    AgencyKycStatus? status,
    AgencyKycView? kyc,
    bool? submitting,
  }) {
    return AgencyKycState(
      status: status ?? this.status,
      kyc: kyc ?? this.kyc,
      submitting: submitting ?? this.submitting,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, kyc, submitting];
}
