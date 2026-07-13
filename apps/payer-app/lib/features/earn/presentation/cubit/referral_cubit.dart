import 'package:equatable/equatable.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the agency referral surface: the real invite link
/// (`POST /payer/agency/invites`) AND the real funnel summary
/// (`GET /payer/agency/referrals/summary`, aggregate + k-anon floor). The link
/// is required to render; the [summary] is best-effort (a failed fetch leaves it
/// null and the counts section is simply hidden). The "how earning works" copy
/// is static. The per-worker "referred" rows have NO endpoint — they stay
/// design-only on a separate screen.
class ReferralCubit extends Cubit<ReferralState> {
  ReferralCubit(this._api) : super(const ReferralState());

  final PayerApiClient _api;

  /// SESSION cache for the minted invite link. `referralLink()` is a WRITE
  /// (`POST /payer/agency/invites`) that mints a NEW code + emits
  /// `agency_invite.created` on every call. The hub is a `registerFactory`
  /// cubit (a fresh instance + `load()` on every open), so without a
  /// process-level cache each open would churn a new invite row/event and show
  /// a different code. Cache it once for the session; only the first load (or an
  /// explicit [refreshLink]) mints one.
  static ReferralLink? _sessionLink;

  /// Test hook — clears the process-level cache so cases start clean.
  @visibleForTesting
  static void resetSessionLink() => _sessionLink = null;

  /// Loads the surface. Reuses the session-cached link when present; only mints
  /// a new one on the first load or when [forceNewLink] is set.
  Future<void> load({bool forceNewLink = false}) async {
    emit(state.copyWith(status: ReferralLoadStatus.loading));
    try {
      final ReferralLink link = (forceNewLink || _sessionLink == null)
          ? (_sessionLink = await _api.referralLink())
          : _sessionLink!;
      // Best-effort aggregate — never fail the whole screen if it errors.
      ReferralsSummary? summary;
      try {
        summary = await _api.fetchReferralsSummary();
      } catch (_) {
        summary = null;
      }
      emit(ReferralState(
        status: ReferralLoadStatus.ready,
        link: link,
        summary: summary,
      ));
    } catch (_) {
      emit(state.copyWith(status: ReferralLoadStatus.error));
    }
  }

  /// Explicit "get a fresh link" action — mints a new code on purpose.
  Future<void> refreshLink() => load(forceNewLink: true);

  /// Records an invite-link click/share for the currently-loaded link
  /// (`POST /payer/agency/invites/:code/click`). FIRE-AND-FORGET: a failure must
  /// never block the share action, so it swallows errors and never emits. No-op
  /// until a link is loaded.
  Future<void> recordClick() async {
    final String? code = state.link?.code;
    if (code == null || code.isEmpty) return;
    try {
      await _api.recordInviteClick(code);
    } catch (_) {
      // Best-effort funnel signal — silently ignore transport/API errors.
    }
  }
}

enum ReferralLoadStatus { initial, loading, ready, error }

class ReferralState extends Equatable {
  const ReferralState({
    this.status = ReferralLoadStatus.initial,
    this.link,
    this.summary,
  });

  final ReferralLoadStatus status;
  final ReferralLink? link;

  /// The aggregate funnel counts (created/clicked/accepted). Null when the
  /// summary fetch failed — the counts section is hidden in that case.
  final ReferralsSummary? summary;

  ReferralState copyWith({
    ReferralLoadStatus? status,
    ReferralLink? link,
    ReferralsSummary? summary,
  }) {
    return ReferralState(
      status: status ?? this.status,
      link: link ?? this.link,
      summary: summary ?? this.summary,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, link, summary];
}
