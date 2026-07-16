import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/auth/auth_error_messages.dart';
import '../../../../core/auth/auth_failure.dart';
import '../../../../core/otp/sms_otp_autofill.dart';
import '../../domain/auth_session_manager.dart';

enum PhoneLoginStatus { initial, submitting, success, failure }

class PhoneLoginState extends Equatable {
  const PhoneLoginState({
    this.status = PhoneLoginStatus.initial,
    this.phone,
    this.message,
  });

  final PhoneLoginStatus status;

  /// The submitted phone, carried so the screen can pass it to the OTP route.
  final String? phone;
  final String? message;

  bool get isSubmitting => status == PhoneLoginStatus.submitting;

  PhoneLoginState copyWith({
    PhoneLoginStatus? status,
    String? phone,
    String? message,
  }) {
    return PhoneLoginState(
      status: status ?? this.status,
      phone: phone ?? this.phone,
      message: message,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, phone, message];
}

/// Drives the phone-entry screen: a single OTP request through
/// [AuthSessionManager] (so the call carries `X-Device-Id` / `X-Locale` via the
/// interceptor). On an [AuthFailure] (e.g. OTP_RATE_LIMITED) it surfaces the
/// localized copy.
class PhoneLoginCubit extends Cubit<PhoneLoginState> {
  PhoneLoginCubit(
    this._manager, {
    String locale = 'hi',
    SmsOtpAutofill? otpAutofill,
  })  : _locale = locale,
        _otpAutofill = otpAutofill,
        super(const PhoneLoginState());

  final AuthSessionManager _manager;
  final String _locale;

  /// Opens the SMS auto-read window. Optional so tests can omit it.
  final SmsOtpAutofill? _otpAutofill;

  Future<void> submit(String phoneE164) async {
    if (state.isSubmitting) return;
    emit(state.copyWith(status: PhoneLoginStatus.submitting, phone: phoneE164));
    // Opened BEFORE the request, not after: SMS User Consent only matches a
    // message that arrives once the window is already open, and the SMS can land
    // before the OTP route has even settled.
    //
    // Dispatched but deliberately NOT awaited. The channel message is enqueued
    // immediately and native opens the window in microseconds, while the SMS
    // takes seconds — so the ordering still holds. Awaiting would instead put a
    // platform call on the critical path of sending an OTP: a wedged or absent
    // Play Services would strand `submitting` and spin the button forever
    // without ever sending one. Auto-read is a convenience; it must never decide
    // whether an OTP goes out.
    //
    // Skipped for a number that cannot receive an SMS at all: the phone is only
    // validated server-side, so a half-typed "+91" still reaches here. Opening a
    // 5-minute window for a doomed request would leave it listening, and an
    // unrelated OTP (a bank, another app) would then pop a baffling "Allow
    // BadaBhai to read this message?" prompt.
    if (_canReceiveSms(phoneE164)) unawaited(_openOtpAutofillWindow());
    try {
      await _manager.requestOtp(phoneE164);
      if (isClosed) return;
      emit(state.copyWith(status: PhoneLoginStatus.success, phone: phoneE164));
    } on AuthFailure catch (failure) {
      if (isClosed) return;
      emit(state.copyWith(
        status: PhoneLoginStatus.failure,
        message: authErrorMessage(failure, _locale),
      ));
    }
  }

  /// Whether [phoneE164] could plausibly receive an SMS at all. An Indian mobile
  /// in E.164 (`+91` + 10 digits) is 12 digits; anything under 10 is a half-typed
  /// number the server will reject, so there is no SMS to wait for.
  ///
  /// Deliberately loose — this ONLY gates the auto-read convenience. Real phone
  /// validation stays server-side; a stricter rule here could silently disable
  /// autofill for a valid number this app has not thought of.
  static bool _canReceiveSms(String phoneE164) =>
      phoneE164.replaceAll(RegExp(r'\D'), '').length >= 10;

  /// Opens the SMS auto-read window. Never throws and never rethrows: it runs
  /// detached from [submit], so an escaping error would surface as an unhandled
  /// async error rather than anything the worker could act on.
  Future<void> _openOtpAutofillWindow() async {
    try {
      await _otpAutofill?.startListening();
    } catch (_) {
      // No Play Services / channel unavailable → the worker types the code.
    }
  }
}
