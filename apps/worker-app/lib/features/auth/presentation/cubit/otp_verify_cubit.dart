import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_api.dart';
import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../domain/auth_session_manager.dart';

enum OtpVerifyStatus { initial, submitting, success, failure }

/// #336 — where a RESEND of the OTP stands.
///
/// Deliberately a SEPARATE axis from [OtpVerifyStatus]: the screen fires its
/// "could not verify" SnackBar off `status`, so folding a resend into it would
/// show wrong-code copy for a code that was never entered — and a resend
/// landing mid-verify would flip the button back out of its loading state.
enum OtpResendStatus { idle, sending, sent, failure }

/// Where the OTP-verify success routes next.
///
///  - [onboarding] — persistent-auth OFF (an explicit `PERSISTENT_AUTH=false`
///    build; the layer is ON by default): replicate main's OTP→consent
///    onboarding; no PIN. The API bearer is the only auth gate.
///  - [setPin]    — new user or `pin_set=false`: must choose a PIN first.
///  - [authenticated] — returning worker with a PIN: straight into the app.
enum OtpNext { onboarding, setPin, authenticated }

class OtpVerifyState extends Equatable {
  const OtpVerifyState({
    this.status = OtpVerifyStatus.initial,
    this.message,
    this.next,
    this.deletionScheduledFor,
    this.resendStatus = OtpResendStatus.idle,
    this.resendInSeconds = 0,
    this.resendMessage,
  });

  final OtpVerifyStatus status;
  final String? message;

  /// Set on success — the screen routes off this (set-PIN vs straight in).
  final OtpNext? next;

  /// Set on success when an account deletion is pending (ADR-0031 grace
  /// window): when the deletion is due. The screen shows the explicit
  /// cancel-prompt BEFORE routing; null = no deletion pending.
  final DateTime? deletionScheduledFor;

  /// #336 — where the last resend stands. `sent` is what the screen watches to
  /// restart its countdown; `failure` carries [resendMessage].
  final OtpResendStatus resendStatus;

  /// #336 — the SERVER's cooldown for the most recent send, in seconds: the
  /// `resend_in_seconds` the API returns from POST /auth/otp/request (already
  /// parsed into [OtpRequestResult.resendIn], and until now thrown away by the
  /// login UI). The screen counts THIS down — never a client constant — so if
  /// the server says 30s the worker waits 30s, and a change to
  /// `OTP_RESEND_COOLDOWN_SECONDS` reaches the app without a release.
  final int resendInSeconds;

  /// Localized copy for a FAILED resend. Kept apart from [message] because the
  /// two errors mean opposite things ("that code was wrong" vs "we could not
  /// send you a code") and one must never overwrite the other.
  final String? resendMessage;

  bool get isSubmitting => status == OtpVerifyStatus.submitting;

  /// True while a resend is in flight — the screen keeps the control disabled.
  bool get isResending => resendStatus == OtpResendStatus.sending;

  /// Copies the state, overriding only the fields passed.
  ///
  /// [deletionScheduledFor] is DELIBERATELY NOT a parameter (ADR-0031, same
  /// reasoning as [Session.copyWith]): its null means "no deletion pending", and
  /// a `??` merge cannot express that — it would silently retain a stale date.
  /// The success path builds the state with the explicit constructor, which is
  /// now the ONLY way to set or clear this field. The submitting/failure paths
  /// below carry the current value through untouched; they never route off it.
  ///
  /// [resendMessage] follows [message]'s clear-unless-passed rule for the same
  /// reason: a stale "could not send" line must not survive the next action.
  OtpVerifyState copyWith({
    OtpVerifyStatus? status,
    String? message,
    OtpNext? next,
    OtpResendStatus? resendStatus,
    int? resendInSeconds,
    String? resendMessage,
  }) {
    return OtpVerifyState(
      status: status ?? this.status,
      message: message,
      next: next ?? this.next,
      deletionScheduledFor: deletionScheduledFor,
      resendStatus: resendStatus ?? this.resendStatus,
      resendInSeconds: resendInSeconds ?? this.resendInSeconds,
      resendMessage: resendMessage,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        message,
        next,
        deletionScheduledFor,
        resendStatus,
        resendInSeconds,
        resendMessage,
      ];
}

/// Drives OTP verification through [AuthSessionManager]. On success the manager
/// has persisted tokens + bridged them into the legacy session; this cubit
/// exposes the routing flag (set-PIN vs authenticated) for the screen.
///
/// PRIVACY (CLAUDE.md §2): the entered OTP is passed straight to [verify] and is
/// NEVER held in state. State is what a BlocObserver / error dump would print,
/// and a one-time code sitting in it is a credential leaked into diagnostics.
/// The code lives only in the screen's TextEditingController for the seconds it
/// takes to submit it. The same goes for the phone: it is an argument, never a
/// field, and is never logged here.
class OtpVerifyCubit extends Cubit<OtpVerifyState> {
  OtpVerifyCubit(this._manager, {String locale = 'hi'})
      : _locale = locale,
        super(const OtpVerifyState());

  final AuthSessionManager _manager;
  final String _locale;

  Future<void> verify({required String phone, required String otp}) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: OtpVerifyStatus.submitting));
    try {
      final OtpVerifyResult result = await _manager.verifyOtp(phone, otp);
      if (isClosed) return;
      // Route off the manager — the single source of truth that respects the
      // persistent-auth gate. Gate OFF (explicit dart-define only) → main's
      // OTP→consent onboarding (no PIN). Gate ON (the default) → `locked` means
      // a new user must set a PIN, anything else means a returning worker goes
      // straight to the shell.
      final OtpNext next;
      if (!_manager.persistentAuthEnabled) {
        next = OtpNext.onboarding; // gate OFF → main's OTP→consent flow
      } else if (_manager.status == AuthStatus.locked) {
        next = OtpNext.setPin; // new user → set a PIN
      } else {
        next = OtpNext.authenticated; // returning worker → shell
      }
      // Built EXPLICITLY, not via copyWith: copyWith's `??` merge cannot
      // express "no deletion pending" — a null [result.deletionScheduledFor]
      // would silently retain a STALE date from an earlier verify on this same
      // cubit (the screen survives behind a pushed consent route), prompting a
      // cancel for a deletion that no longer exists. ADR-0031 honest nulls: the
      // server response is authoritative, including its absence.
      emit(OtpVerifyState(
        status: OtpVerifyStatus.success,
        next: next,
        // Surfaced so the screen can prompt the explicit cancel before routing;
        // null (the usual case) means no deletion pending.
        deletionScheduledFor: result.deletionScheduledFor,
        // #336 — carried through by hand (this constructor takes no defaults
        // from the old state): the screen survives behind the pushed consent
        // route, and resetting these to idle/0 here would make its resend
        // listener see a phantom transition and re-arm the control mid-route.
        resendStatus: state.resendStatus,
        resendInSeconds: state.resendInSeconds,
      ));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: OtpVerifyStatus.failure,
        message: authErrorMessage(failure, _locale),
      ));
    }
  }

  /// #336 — send the worker a fresh OTP for [phone].
  ///
  /// This is a SPEND CONTROL, not polish. There is no mock SMS path: OTP goes
  /// out over real Fast2SMS and every resend is a real, billed message. Three
  /// things stand between an impatient worker and a stack of them:
  ///
  ///  1. the screen disables the control for [OtpVerifyState.resendInSeconds]
  ///     and shows the seconds left, so the wait is visible rather than a dead
  ///     button;
  ///  2. the `isResending` guard below drops a re-entrant tap while a request
  ///     is in flight (a double-tap on a slow network used to be two sends);
  ///  3. the server's own `OTP_RESEND_COOLDOWN_SECONDS` window is the
  ///     AUTHORITATIVE gate — an early request comes back OTP_RATE_LIMITED and
  ///     no SMS is sent. The client cooldown mirrors it; it never replaces it.
  ///
  /// The new cooldown is taken from the server's response, so the client never
  /// guesses how long to wait.
  Future<void> resend({required String phone}) async {
    if (state.isResending) return;
    emit(state.copyWith(resendStatus: OtpResendStatus.sending));
    try {
      final OtpRequestResult result = await _manager.requestOtp(phone);
      if (isClosed) return;
      emit(state.copyWith(
        resendStatus: OtpResendStatus.sent,
        resendInSeconds: result.resendIn.inSeconds,
      ));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      // Honest reason, not a generic "check internet" — a rate-limit and a dead
      // network need different things from the worker. `status` is untouched:
      // a failed SEND says nothing about the code already in the field.
      emit(state.copyWith(
        resendStatus: OtpResendStatus.failure,
        resendMessage: authErrorMessage(failure, _locale),
      ));
    }
  }
}
