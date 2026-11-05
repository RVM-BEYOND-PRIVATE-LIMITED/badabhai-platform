import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/consent/voice_consent.dart';
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../../auth/domain/auth_session_manager.dart';
import '../../domain/consent_repository.dart';

enum ConsentStatus { idle, submitting, success, failure }

class ConsentState extends Equatable {
  const ConsentState({
    this.accepted = false,
    this.declined = false,
    this.status = ConsentStatus.idle,
    this.message,
  });

  /// Whether the "I agree" box is ticked (presentation state held here so the
  /// widget stays logic-free).
  final bool accepted;

  /// OWNER ASK (2026-10-22) — whether the "I don't agree" box is ticked. Only
  /// one of [accepted] / [declined] is ever true.
  final bool declined;
  final ConsentStatus status;
  final String? message;

  bool get isSubmitting => status == ConsentStatus.submitting;
  bool get canSubmit => (accepted || declined) && !isSubmitting;

  ConsentState copyWith({
    bool? accepted,
    bool? declined,
    ConsentStatus? status,
    String? message,
  }) {
    return ConsentState(
      accepted: accepted ?? this.accepted,
      declined: declined ?? this.declined,
      status: status ?? this.status,
      message: message ?? this.message,
    );
  }

  @override
  List<Object?> get props => <Object?>[accepted, declined, status, message];
}

class ConsentCubit extends Cubit<ConsentState> {
  ConsentCubit(this._repo) : super(const ConsentState());

  final ConsentRepository _repo;

  /// Consent purposes granted by the single onboarding "I agree" gate.
  ///
  /// `voice_processing` added 2026-08-28 (#1270, approved in #1269) alongside
  /// the DPDP voice notice copy landing in `consent_screen.dart` — the purpose
  /// is only requested once the worker has actually been shown what it means.
  static const List<String> _purposes = <String>[
    'profiling',
    'resume_generation',
    'voice_processing',
  ];

  /// OWNER ASK (2026-10-22) — the purposes a worker gives when they do NOT
  /// allow voice recording: everything except [kVoiceConsentPurpose], so they
  /// still build a profile and résumé by TYPING (the notice's own promise:
  /// "Agar aap ijaazat nahi dete, tab bhi aap poora interview type karke de
  /// sakte hain").
  static final List<String> _typingOnlyPurposes = <String>[
    for (final String p in _purposes)
      if (p != kVoiceConsentPurpose) p,
  ];

  /// Ticking "I agree" clears "I don't agree" — only one answer at a time.
  void setAccepted(bool accepted) => emit(
        state.copyWith(
          accepted: accepted,
          declined: accepted ? false : state.declined,
        ),
      );

  /// Ticking "I don't agree" clears "I agree" — only one answer at a time.
  void setDeclined(bool declined) => emit(
        state.copyWith(
          declined: declined,
          accepted: declined ? false : state.accepted,
        ),
      );

  /// "Aage Badhein": sends whichever answer is ticked — "I agree" gives every
  /// purpose (voice included), "I don't agree" gives typing only.
  Future<void> submit() async {
    if (!state.canSubmit) return;
    if (state.accepted) {
      await _give(_purposes, voiceGranted: true);
    } else {
      await _give(_typingOnlyPurposes, voiceGranted: false);
    }
  }

  /// OWNER ASK (2026-10-22) — "I don't agree": no voice consent. The worker
  /// carries on by typing, and every voice control in the app is hidden.
  Future<void> decline() async {
    if (state.isSubmitting) return;
    await _give(_typingOnlyPurposes, voiceGranted: false);
  }

  Future<void> _give(
    List<String> purposes, {
    required bool voiceGranted,
  }) async {
    emit(state.copyWith(status: ConsentStatus.submitting));
    try {
      await _repo.acceptConsent(purposes: purposes);
      if (isClosed) return;
      // TD62: release the router's consent gate immediately after a successful
      // consent.accepted — guarded lookup so plain cubit tests (no auth graph
      // in the locator) keep constructing ConsentCubit directly.
      if (locator.isRegistered<AuthSessionManager>()) {
        locator<AuthSessionManager>().markConsentAccepted();
      }
      VoiceConsent.instance.set(granted: voiceGranted);
      // B7 funnel milestone, mirroring the server's `consent.accepted` event.
      // The COUNT of purposes only — never the worker, never the purposes.
      unawaited(BbAnalytics.instance
          .log(BbAnalytics.consentDone(purposeCount: purposes.length)));
      emit(state.copyWith(status: ConsentStatus.success));
    } on Failure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(status: ConsentStatus.failure, message: failure.message));
    }
  }
}
