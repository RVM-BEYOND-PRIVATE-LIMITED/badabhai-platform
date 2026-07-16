import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/otp/sms_otp_autofill.dart';

/// The REAL SMS our DLT template sends (sender: JM-RVMOTP-T).
const String _realSms =
    'Your OTP is 895218. Do not share it. - RVM Beyond Private Limited';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('extractCode — against the live template', () {
    test('pulls the code out of the real OTP SMS', () {
      expect(SmsOtpAutofill.extractCode(_realSms), '895218');
    });

    test('ignores the trailing brand text (no digits to mistake)', () {
      expect(
        SmsOtpAutofill.extractCode('Your OTP is 4321. - RVM Beyond Pvt Ltd'),
        '4321',
      );
    });

    // A 10-digit phone number must NOT be sliced into a "code" — the word
    // boundaries are what stop `\d{4,8}` from matching the first 8 digits.
    test('never slices a longer digit run (phone number) into a code', () {
      expect(SmsOtpAutofill.extractCode('Call us on 9876500000 for help'),
          isNull);
    });

    test('returns null when there is no code at all', () {
      expect(SmsOtpAutofill.extractCode('Welcome to BadaBhai!'), isNull);
      expect(SmsOtpAutofill.extractCode(''), isNull);
      expect(SmsOtpAutofill.extractCode(null), isNull);
    });

    test('accepts the full 4-8 digit range the API allows', () {
      expect(SmsOtpAutofill.extractCode('code 1234 hai'), '1234');
      expect(SmsOtpAutofill.extractCode('code 12345678 hai'), '12345678');
    });
  });

  group('channel wiring', () {
    late List<MethodCall> calls;
    late SmsOtpAutofill autofill;
    const MethodChannel channel = MethodChannel(SmsOtpAutofill.channelName);

    setUp(() {
      calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (MethodCall call) async {
        calls.add(call);
        return null;
      });
      autofill = SmsOtpAutofill(enabled: true);
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
      autofill.dispose();
    });

    /// Simulates Play Services delivering the consented SMS to Dart.
    Future<void> deliver(String body) async {
      await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .handlePlatformMessage(
        SmsOtpAutofill.channelName,
        const StandardMethodCodec()
            .encodeMethodCall(MethodCall('onSms', body)),
        (_) {},
      );
    }

    test('startListening opens the native consent window', () async {
      await autofill.startListening();
      expect(calls.single.method, 'start');
    });

    test('stopListening closes it', () async {
      await autofill.stopListening();
      expect(calls.single.method, 'stop');
    });

    test('a delivered SMS surfaces the code on the stream', () async {
      final Future<String> next = autofill.codes.first;
      await deliver(_realSms);
      expect(await next, '895218');
    });

    // The SMS routinely lands before the OTP route settles, so a code that
    // arrives with nobody listening must survive until the screen mounts.
    test('a code arriving before anyone listens is buffered', () async {
      await deliver(_realSms);
      expect(autofill.takeBufferedCode(), '895218');
      expect(autofill.takeBufferedCode(), isNull, reason: 'drained once only');
    });

    // Otherwise a resend would autofill the PREVIOUS code — the worker submits
    // a dead OTP and burns a verify attempt.
    test('startListening drops a stale buffered code', () async {
      await deliver(_realSms);
      await autofill.startListening();
      expect(autofill.takeBufferedCode(), isNull);
    });

    test('a non-OTP SMS never buffers garbage', () async {
      await deliver('Welcome to BadaBhai!');
      expect(autofill.takeBufferedCode(), isNull);
    });

    test('a failing platform call is swallowed (manual entry still works)',
        () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (MethodCall call) async {
        throw MissingPluginException('no Play Services');
      });
      await expectLater(autofill.startListening(), completes);
    });

    test('disabled (iOS/web) makes no platform call at all', () async {
      final SmsOtpAutofill off = SmsOtpAutofill(enabled: false);
      await off.startListening();
      await off.stopListening();
      expect(calls, isEmpty);
      expect(off.isSupported, isFalse);
      off.dispose();
    });
  });
}
