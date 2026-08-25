import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the agency's earnings + payout-gate state (`GET /payer/agency/earnings`)
/// and drives the payout REQUEST (`POST /payer/agency/payouts`). AGENT-only AND
/// FLAG-GATED: the routes return a NEUTRAL 404 while `AGENCY_PAYOUTS_ENABLED` is
/// off, which this cubit maps to a distinct [AgencyEarningsStatus.unavailable]
/// ("not available yet") — never a crash or a generic error. A company session's
/// 403 maps to [AgencyEarningsStatus.forbidden].
///
/// The payout REQUEST is a MONEY-OUT surface (an agent withdrawing earned
/// commission) — there is NO gateway/card/checkout here, only a plain authed
/// POST; the server owns the gate ([AgencyEarnings.canRequest]) and this cubit
/// never re-derives eligibility on the client.
class AgencyEarningsCubit extends Cubit<AgencyEarningsState> {
  AgencyEarningsCubit(this._api) : super(const AgencyEarningsState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: AgencyEarningsStatus.loading));
    try {
      final AgencyEarnings earnings = await _api.fetchAgencyEarnings();
      emit(AgencyEarningsState(
        status: AgencyEarningsStatus.ready,
        earnings: earnings,
      ));
    } on PayerApiException catch (e) {
      emit(state.copyWith(status: _statusFor(e.statusCode)));
    } catch (_) {
      emit(state.copyWith(status: AgencyEarningsStatus.error));
    }
  }

  /// Request a payout of the currently-requestable accruals. Returns a
  /// [PayoutActionResult] the screen shows as a toast; on a successful request
  /// (or a gate refusal that changed the server truth) it refetches so the
  /// balances + the button state update. Guarded by [state.requesting] so a
  /// double-tap cannot fire two requests.
  Future<PayoutActionResult> requestPayout() async {
    if (state.requesting) {
      return const PayoutActionResult.fail('Please wait…');
    }
    emit(state.copyWith(requesting: true));
    try {
      final PayoutRequestResult result = await _api.requestAgencyPayout();
      if (result.ok) {
        await load(); // reflect the moved ₹ + the new "in request" total
        emit(state.copyWith(requesting: false));
        final int amount = result.amountInr ?? 0;
        return PayoutActionResult.ok(
          'Payout requested — ₹$amount is on its way.',
        );
      }
      // A gate refusal changed nothing server-side; refetch so the reason the
      // UI shows matches server truth, then surface an honest message.
      await load();
      emit(state.copyWith(requesting: false));
      return PayoutActionResult.fail(_blockedMessage(result.blockedReason));
    } on PayerApiException catch (e) {
      // The flag flipped off (or role changed) between the load and the tap —
      // degrade to the honest unavailable/forbidden view rather than a crash.
      final AgencyEarningsStatus mapped = _statusFor(e.statusCode);
      emit(state.copyWith(status: mapped, requesting: false));
      return PayoutActionResult.fail(
        mapped == AgencyEarningsStatus.unavailable
            ? 'Payouts are not available yet.'
            : 'Could not request a payout. Please try again.',
      );
    } catch (_) {
      emit(state.copyWith(requesting: false));
      return const PayoutActionResult.fail(
        'Network error. Check your connection.',
      );
    }
  }

  /// Human copy for a gate-refusal CODE (never the raw enum on-screen).
  static String _blockedMessage(String? reason) {
    switch (reason) {
      case 'kyc_not_verified':
        return 'Your KYC needs to be verified before a payout.';
      case 'below_threshold':
        return "You haven't reached the minimum payout amount yet.";
      case 'disabled':
        return 'Payouts are not available yet.';
      default:
        return 'Could not request a payout right now.';
    }
  }

  static AgencyEarningsStatus _statusFor(int code) {
    switch (code) {
      case 404:
        // The neutral 404 from AgencyPayoutsEnabledGuard (flag off).
        return AgencyEarningsStatus.unavailable;
      case 403:
        return AgencyEarningsStatus.forbidden;
      default:
        return AgencyEarningsStatus.error;
    }
  }
}

/// The outcome of a one-shot payout action — a success flag + a human message
/// the screen shows as a toast. Never carries PII or a raw code.
class PayoutActionResult {
  const PayoutActionResult.ok(this.message) : success = true;
  const PayoutActionResult.fail(this.message) : success = false;

  final bool success;
  final String message;
}

enum AgencyEarningsStatus {
  initial,
  loading,
  ready,

  /// The launch flag is OFF (a neutral 404) — show an honest "not available yet".
  unavailable,

  /// Agent-only route hit by a non-agent session (403).
  forbidden,
  error,
}

class AgencyEarningsState extends Equatable {
  const AgencyEarningsState({
    this.status = AgencyEarningsStatus.initial,
    this.earnings,
    this.requesting = false,
  });

  final AgencyEarningsStatus status;
  final AgencyEarnings? earnings;

  /// True while a payout request is in flight (disables the button).
  final bool requesting;

  AgencyEarningsState copyWith({
    AgencyEarningsStatus? status,
    AgencyEarnings? earnings,
    bool? requesting,
  }) {
    return AgencyEarningsState(
      status: status ?? this.status,
      earnings: earnings ?? this.earnings,
      requesting: requesting ?? this.requesting,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, earnings, requesting];
}
