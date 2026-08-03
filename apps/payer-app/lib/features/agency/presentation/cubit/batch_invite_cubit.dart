import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Mints a BATCH of agency invite codes (`POST /payer/agency/invites/batch`,
/// AGENT-only). Faceless input: a [count] (1..50) + an optional non-PII campaign
/// tag — never a worker id/phone.
///
/// The neutral 429 (mint cap) is a RETRYABLE state — the last request is kept so
/// [retry] re-submits it verbatim. A 403 (company session) is the honest
/// agent-only state; any other non-2xx is the generic error. On any failure the
/// previously minted batch is preserved so codes already handed out never vanish.
class BatchInviteCubit extends Cubit<BatchInviteState> {
  BatchInviteCubit(this._api) : super(const BatchInviteState());

  final PayerApiClient _api;

  static const int minCount = 1;
  static const int maxCount = 50;

  Future<void> mint({required int count, String? campaign}) async {
    final int clamped = count.clamp(minCount, maxCount);
    final String? tag =
        (campaign != null && campaign.trim().isNotEmpty) ? campaign.trim() : null;
    emit(state.copyWith(
      status: BatchInviteStatus.submitting,
      lastCount: clamped,
      lastCampaign: tag,
      clearCampaign: tag == null,
    ));
    try {
      final List<MintedInvite> invites =
          await _api.createInviteBatch(count: clamped, campaign: tag);
      emit(state.copyWith(
        status: BatchInviteStatus.ready,
        invites: invites,
      ));
    } on PayerApiException catch (e) {
      emit(state.copyWith(status: _statusFor(e.statusCode)));
    } catch (_) {
      emit(state.copyWith(status: BatchInviteStatus.error));
    }
  }

  /// Re-submit the last request — used by the neutral 429 retry affordance.
  Future<void> retry() async {
    final int? count = state.lastCount;
    if (count == null) return;
    await mint(count: count, campaign: state.lastCampaign);
  }

  static BatchInviteStatus _statusFor(int code) {
    switch (code) {
      case 403:
        return BatchInviteStatus.forbidden;
      case 429:
        return BatchInviteStatus.rateLimited;
      default:
        return BatchInviteStatus.error;
    }
  }
}

enum BatchInviteStatus { idle, submitting, ready, forbidden, rateLimited, error }

class BatchInviteState extends Equatable {
  const BatchInviteState({
    this.status = BatchInviteStatus.idle,
    this.invites = const <MintedInvite>[],
    this.lastCount,
    this.lastCampaign,
  });

  final BatchInviteStatus status;
  final List<MintedInvite> invites;
  final int? lastCount;
  final String? lastCampaign;

  bool get isSubmitting => status == BatchInviteStatus.submitting;

  BatchInviteState copyWith({
    BatchInviteStatus? status,
    List<MintedInvite>? invites,
    int? lastCount,
    String? lastCampaign,
    bool clearCampaign = false,
  }) {
    return BatchInviteState(
      status: status ?? this.status,
      invites: invites ?? this.invites,
      lastCount: lastCount ?? this.lastCount,
      lastCampaign: clearCampaign ? null : (lastCampaign ?? this.lastCampaign),
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, invites, lastCount, lastCampaign];
}
