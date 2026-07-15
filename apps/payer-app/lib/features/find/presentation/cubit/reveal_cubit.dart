import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Drives the REAL Reveal screen: exchanges a granted `unlockId` for an in-app
/// relay handle (`POST /payer/unlocks/:id/reveal`) on open, and — on demand —
/// fetches a MASKED résumé URL (`POST /payer/resume-disclosures`). Both neutral
/// DENYs (`{status:"unavailable"}`) surface as typed states, never exceptions,
/// and NO fabricated name/phone is ever shown.
class RevealCubit extends Cubit<RevealState> {
  RevealCubit(this._api) : super(const RevealState());

  final PayerApiClient _api;

  Future<void> load(String unlockId) async {
    emit(state.copyWith(status: RevealStatus.loading));
    try {
      final RevealResult result = await _api.reveal(unlockId);
      if (!result.revealed) {
        emit(state.copyWith(status: RevealStatus.unavailable));
        return;
      }
      emit(state.copyWith(
        status: RevealStatus.ready,
        relayHandle: result.relayHandle,
        channel: result.channel,
        expiresAt: result.expiresAt,
      ));
    } catch (_) {
      emit(state.copyWith(status: RevealStatus.error));
    }
  }

  /// Fetch the signed MASKED-résumé URL for [workerId]. Returns the typed result
  /// so the screen can open/copy the URL on success or toast the neutral deny.
  ///
  /// A thrown [PayerApiException]/transport failure is an OUTAGE, not a deny —
  /// it emits [DisclosureStatus.error] (retryable copy), never `unavailable`
  /// (the neutral-deny copy is reserved for the genuine 200-deny).
  Future<DisclosureResult> discloseResume({
    required String workerId,
    String? jobPostingId,
  }) async {
    emit(state.copyWith(disclosure: DisclosureStatus.loading));
    try {
      final DisclosureResult result = await _api.disclose(
        workerId: workerId,
        jobPostingId: jobPostingId,
      );
      emit(state.copyWith(
        disclosure:
            result.disclosed ? DisclosureStatus.ready : DisclosureStatus.unavailable,
        resumeUrl: result.resumeUrl,
      ));
      return result;
    } catch (_) {
      emit(state.copyWith(disclosure: DisclosureStatus.error));
      return const DisclosureResult.unavailable();
    }
  }

  /// Load the caller's OWN masked-resume disclosure history
  /// (`GET /payer/resume-disclosures`, newest-first). PII-free rows. A failure
  /// surfaces as [DisclosureHistoryStatus.error] (the real reason — never a
  /// silent empty list).
  Future<void> loadDisclosures() async {
    emit(state.copyWith(historyStatus: DisclosureHistoryStatus.loading));
    try {
      final List<PayerDisclosure> rows = await _api.listDisclosures();
      emit(state.copyWith(
        historyStatus: DisclosureHistoryStatus.ready,
        disclosures: rows,
      ));
    } catch (_) {
      emit(state.copyWith(historyStatus: DisclosureHistoryStatus.error));
    }
  }
}

enum RevealStatus { initial, loading, ready, unavailable, error }

enum DisclosureStatus { idle, loading, ready, unavailable, error }

enum DisclosureHistoryStatus { idle, loading, ready, error }

class RevealState extends Equatable {
  const RevealState({
    this.status = RevealStatus.initial,
    this.relayHandle,
    this.channel,
    this.expiresAt,
    this.disclosure = DisclosureStatus.idle,
    this.resumeUrl,
    this.historyStatus = DisclosureHistoryStatus.idle,
    this.disclosures = const <PayerDisclosure>[],
  });

  final RevealStatus status;
  final String? relayHandle;
  final String? channel;
  final String? expiresAt;
  final DisclosureStatus disclosure;
  final String? resumeUrl;

  /// The caller's own disclosure history (`GET /payer/resume-disclosures`).
  final DisclosureHistoryStatus historyStatus;
  final List<PayerDisclosure> disclosures;

  /// Human channel label — the relay is an in-app address, never a raw phone.
  String get channelLabel => switch (channel) {
        'proxy_number' => 'Proxy number',
        _ => 'In-app relay',
      };

  RevealState copyWith({
    RevealStatus? status,
    String? relayHandle,
    String? channel,
    String? expiresAt,
    DisclosureStatus? disclosure,
    String? resumeUrl,
    DisclosureHistoryStatus? historyStatus,
    List<PayerDisclosure>? disclosures,
  }) {
    return RevealState(
      status: status ?? this.status,
      relayHandle: relayHandle ?? this.relayHandle,
      channel: channel ?? this.channel,
      expiresAt: expiresAt ?? this.expiresAt,
      disclosure: disclosure ?? this.disclosure,
      resumeUrl: resumeUrl ?? this.resumeUrl,
      historyStatus: historyStatus ?? this.historyStatus,
      disclosures: disclosures ?? this.disclosures,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        relayHandle,
        channel,
        expiresAt,
        disclosure,
        resumeUrl,
        historyStatus,
        disclosures,
      ];
}
