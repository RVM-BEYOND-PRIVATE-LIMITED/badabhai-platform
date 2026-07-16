import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Reads the OTP out of the incoming SMS so the worker never has to type it.
///
/// ANDROID — Play Services **SMS User Consent**. Chosen over the fully-silent
/// SMS Retriever API because Retriever requires an 11-character app hash inside
/// the SMS body (`<#> ... FA+9qCX9VSu`), and our DLT-approved template
/// ("Your OTP is 895218. Do not share it. - RVM Beyond Private Limited") carries
/// no hash. Changing it means a new DLT approval, so Retriever is not available
/// to us today. User Consent needs no hash and no SMS permission — the OS shows
/// one "Allow?" tap, then hands us just that one message.
///
/// The API only matches an SMS that arrives AFTER [startListening], contains a
/// 4-8 digit code, and comes from a non-contact — so [startListening] must be
/// called when the OTP is REQUESTED, not when the OTP screen mounts (the SMS can
/// land before the route settles). It listens for 5 minutes, then times out.
///
/// iOS — no platform work: the OTP field's [AutofillHints.oneTimeCode] makes the
/// OS surface the code above the keyboard natively. This service no-ops there.
///
/// NEVER logs the SMS body or the code.
class SmsOtpAutofill {
  SmsOtpAutofill({MethodChannel? channel, bool? enabled})
      : _channel = channel ?? const MethodChannel(channelName),
        // Android-only: the channel is not implemented on any other platform, so
        // calling it there would just throw MissingPluginException.
        _enabled = enabled ??
            (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
    _channel.setMethodCallHandler(_onNativeCall);
  }

  /// Must match the channel name in `MainActivity.kt`.
  static const String channelName = 'badabhai/sms_otp';

  final MethodChannel _channel;
  final bool _enabled;

  final StreamController<String> _codes = StreamController<String>.broadcast();

  /// Holds a code that arrived before the OTP screen subscribed — the SMS can
  /// beat the navigation. Drained by [takeBufferedCode] on mount.
  String? _buffered;

  /// Codes detected while listening. Broadcast: late subscribers get only new
  /// codes, so a screen must ALSO drain [takeBufferedCode] on mount.
  Stream<String> get codes => _codes.stream;

  /// Whether this platform can auto-read the SMS at all (Android only).
  bool get isSupported => _enabled;

  /// Returns a code that landed before anyone subscribed, and clears it.
  String? takeBufferedCode() {
    final String? code = _buffered;
    _buffered = null;
    return code;
  }

  /// Starts the 5-minute consent window. Call immediately BEFORE requesting the
  /// OTP. Idempotent; drops any stale buffered code from a previous request so a
  /// resend can never autofill the old code.
  ///
  /// Never throws: auto-read is a convenience, and a device with no Play
  /// Services (or a failed platform call) must still be able to type the OTP.
  Future<void> startListening() async {
    _buffered = null;
    if (!_enabled) return;
    try {
      await _channel.invokeMethod<void>('start');
    } catch (_) {
      // No Play Services / channel unavailable → manual entry still works.
    }
  }

  /// Ends the consent window early (OTP verified or the screen left).
  Future<void> stopListening() async {
    if (!_enabled) return;
    try {
      await _channel.invokeMethod<void>('stop');
    } catch (_) {
      // Best-effort — the native window self-expires after 5 minutes anyway.
    }
  }

  Future<dynamic> _onNativeCall(MethodCall call) async {
    if (call.method != 'onSms') return null;
    final Object? body = call.arguments;
    final String? code = extractCode(body is String ? body : null);
    if (code == null) return null;
    _buffered = code;
    _codes.add(code);
    return null;
  }

  /// Pulls the OTP out of an SMS body.
  ///
  /// Matches the FIRST standalone run of 4-8 digits — the backend mints
  /// `OTP_LENGTH` (default 6, bounded 4-8 by the API's own DTO). The word
  /// boundaries matter: they stop a longer digit run (a phone number, an order
  /// id) from being sliced into a plausible-looking code. Returns null when
  /// nothing matches, so a marketing SMS can never autofill garbage.
  static String? extractCode(String? body) {
    if (body == null || body.isEmpty) return null;
    return RegExp(r'\b\d{4,8}\b').firstMatch(body)?.group(0);
  }

  void dispose() {
    _channel.setMethodCallHandler(null);
    _codes.close();
  }
}
