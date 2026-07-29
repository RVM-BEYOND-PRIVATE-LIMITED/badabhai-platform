import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Drives the agency Refer-&-earn screen: the shareable invite link
/// (`POST /payer/agency/invites` → `{code, link}`) + the funnel summary
/// (`GET /payer/agency/referrals/summary`). Both are agent-only, real routes.
///
/// A load failure surfaces the standard retry view rather than a silent empty
/// screen. [recordShare] is a best-effort funnel signal fired when the agent
/// copies/shares the link — never blocks the UI, never surfaces an error.
class ReferralCubit extends Cubit<ReferralState> {
  ReferralCubit(this._api) : super(const ReferralState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: ReferralStatus.loading));
    try {
      final ReferralsSummary summary = await _api.fetchReferralsSummary();
      final ReferralLink link = await _api.referralLink();
      emit(ReferralState(
        status: ReferralStatus.ready,
        summary: summary,
        link: link,
      ));
    } catch (_) {
      emit(state.copyWith(status: ReferralStatus.error));
    }
  }

  /// Record that the agent shared/copied their invite link
  /// (`POST /payer/agency/invites/:code/click`). Fire-and-forget: an error is
  /// swallowed (the share already happened; the counter is a soft signal).
  Future<void> recordShare() async {
    final String? code = state.link?.code;
    if (code == null) return;
    try {
      await _api.recordInviteClick(code);
    } catch (_) {
      // Best-effort funnel signal — never surfaced.
    }
  }
}

enum ReferralStatus { initial, loading, ready, error }

class ReferralState extends Equatable {
  const ReferralState({
    this.status = ReferralStatus.initial,
    this.summary,
    this.link,
  });

  final ReferralStatus status;
  final ReferralsSummary? summary;
  final ReferralLink? link;

  ReferralState copyWith({
    ReferralStatus? status,
    ReferralsSummary? summary,
    ReferralLink? link,
  }) {
    return ReferralState(
      status: status ?? this.status,
      summary: summary ?? this.summary,
      link: link ?? this.link,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, summary, link];
}
