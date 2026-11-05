import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/consent/voice_consent.dart';
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../../auth/domain/auth_session_manager.dart';
import '../../domain/consent_repository.dart';

enum ConsentStatus { idle, submitting, success, failure, ageBlocked }

class ConsentState extends Equatable {
  const ConsentState({
    this.accepted = false,
    this.declined = false,
    this.age18Plus,
    this.status = ConsentStatus.idle,
    this.message,
  });

  /// Whether the "I agree" box is ticked (presentation state held here so the
  /// widget stays logic-free).
  final bool accepted;

  /// Whether the "I don't agree" box is ticked. Only one of [accepted] /
  /// [declined] is ever true (owner ruling 2026-11-05): the two ticks are
  /// mutually exclusive, and a decline proceeds type-only after a confirm.
  final bool declined;

  /// The worker's answer to the sign-up age gate: `true` for 18+, `false` for
  /// under 18, `null` until they pick one. Never sent as a string.
  final bool? age18Plus;
  final ConsentStatus status;
  final String? message;

  bool get isSubmitting => status == ConsentStatus.submitting;
  bool get canSubmit =>
      (accepted || declined) && age18Plus != null && !isSubmitting;

  ConsentState copyWith({
    bool? accepted,
    bool? declined,
    bool? age18Plus,
    ConsentStatus? status,
    String? message,
  }) {
    return ConsentState(
      accepted: accepted ?? this.accepted,
      declined: declined ?? this.declined,
      age18Plus: age18Plus ?? this.age18Plus,
      status: status ?? this.status,
      message: message ?? this.message,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[accepted, declined, age18Plus, status, message];
}

class ConsentCubit extends Cubit<ConsentState> {
  ConsentCubit(this._repo) : super(const ConsentState());

  final ConsentRepository _repo;

  /// Consent purposes granted by the single onboarding "I agree" gate.
  ///
  /// `voice_processing` added 2026-08-28 (#1270, approved in #1269) alongside
  /// the DPDP voice notice copy landing in `consent_screen.dart` — the purpose
  /// is only requested once the worker has actually been shown what it means.
  ///
  /// `employer_sharing` + `employer_messaging` added 2026-11-04 on the same
  /// rule: the approved employer-sharing notice
  /// (`docs/product/employer-sharing-consent-notice.md`) is now a card on the
  /// same screen, under the same one tick. They ride with `kConsentVersion`
  /// 2026-11-04 — the server rejects them paired with any other version.
  static const List<String> _purposes = <String>[
    'profiling',
    'resume_generation',
    'voice_processing',
    'employer_sharing',
    'employer_messaging',
  ];

  /// The purposes a worker grants when they do NOT allow voice recording: the
  /// same set without `voice_processing`. The notice's own promise is that the
  /// whole interview can be typed, so nothing else is withheld. The backend
  /// accepts any non-empty subset of the known purposes (no server change).
  static const List<String> _typingOnlyPurposes = <String>[
    'profiling',
    'resume_generation',
    'employer_sharing',
    'employer_messaging',
  ];

  /// Ticking "I agree" unticks "I don't agree" (owner ruling 2026-11-05).
  void setAccepted(bool accepted) => emit(state.copyWith(
        accepted: accepted,
        declined: accepted ? false : state.declined,
      ));

  /// Ticking "I don't agree" unticks "I agree" (owner ruling 2026-11-05).
  void setDeclined(bool declined) => emit(state.copyWith(
        declined: declined,
        accepted: declined ? false : state.accepted,
      ));

  /// Set by the age-gate chips. `false` is only reached after the screen's
  /// "Pakka?" confirm, so a mis-tap can never sign the worker out.
  void setAge18Plus(bool age18Plus) =>
      emit(state.copyWith(age18Plus: age18Plus));

  Future<void> submit() async {
    if (!state.canSubmit) return;
    final bool voiceGranted = !state.declined;
    final List<String> purposes =
        voiceGranted ? _purposes : _typingOnlyPurposes;
    emit(state.copyWith(status: ConsentStatus.submitting));
    try {
      await _repo.acceptConsent(
        purposes: purposes,
        age18Plus: state.age18Plus!,
      );
      if (isClosed) return;
      // TD62: release the router's consent gate immediately after a successful
      // consent.accepted — guarded lookup so plain cubit tests (no auth graph
      // in the locator) keep constructing ConsentCubit directly.
      if (locator.isRegistered<AuthSessionManager>()) {
        locator<AuthSessionManager>().markConsentAccepted();
      }
      // A declined voice consent hides every voice control downstream, so the
      // worker answers the whole interview by typing (the notice's promise).
      VoiceConsent.instance.set(granted: voiceGranted);
      // B7 funnel milestone, mirroring the server's `consent.accepted` event.
      // The COUNT of purposes only — never the worker, never the purposes.
      unawaited(
        BbAnalytics.instance.log(
          BbAnalytics.consentDone(purposeCount: purposes.length),
        ),
      );
      emit(state.copyWith(status: ConsentStatus.success));
    } on AgeBelowMinimumFailure {
      if (isClosed) return;
      // The server wrote NO consent, so the session is now useless. The screen
      // shows the terminal under-18 message; [acknowledgeAgeBlock] then wipes
      // the local session and sends the worker back to phone login.
      emit(state.copyWith(status: ConsentStatus.ageBlocked));
    } on Failure catch (failure) {
      if (isClosed) return;
      emit(
        state.copyWith(status: ConsentStatus.failure, message: failure.message),
      );
    }
  }

  /// The worker has read the terminal under-18 screen. Clear tokens + PIN
  /// unlock state locally and let the router land on phone login. Local-only:
  /// the server deliberately does not revoke an under-18 sign-up's sessions,
  /// and every processing route is consent-gated anyway.
  Future<void> acknowledgeAgeBlock() async {
    if (state.status != ConsentStatus.ageBlocked || _leaving) return;
    _leaving = true;
    if (locator.isRegistered<AuthSessionManager>()) {
      await locator<AuthSessionManager>().discardSession();
    }
  }

  bool _leaving = false;
}
