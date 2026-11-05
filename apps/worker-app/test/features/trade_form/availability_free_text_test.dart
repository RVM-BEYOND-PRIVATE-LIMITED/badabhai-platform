import 'package:badabhai_worker_app/features/trade_form/domain/availability_free_text.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('parseAvailabilityFreeText', () {
    test('dedh mahina is a 45-day notice', () {
      final AvailabilityFreeText? parsed =
          parseAvailabilityFreeText('dedh mahina');
      expect(parsed, isNotNull);
      expect(parsed!.status, 'serving_notice');
      expect(parsed.noticeDays, 45);
    });

    test('2 mahine is a 60-day notice', () {
      final AvailabilityFreeText? parsed =
          parseAvailabilityFreeText('2 mahine');
      expect(parsed, isNotNull);
      expect(parsed!.status, 'serving_notice');
      expect(parsed.noticeDays, 60);
    });

    test('a bare 2 means 2 mahine', () {
      final AvailabilityFreeText? parsed = parseAvailabilityFreeText('2');
      expect(parsed, isNotNull);
      expect(parsed!.status, 'serving_notice');
      expect(parsed.noticeDays, 60);
    });

    test('15 din is a 15-day notice', () {
      final AvailabilityFreeText? parsed =
          parseAvailabilityFreeText('15 din ka notice hai');
      expect(parsed, isNotNull);
      expect(parsed!.status, 'serving_notice');
      expect(parsed.noticeDays, 15);
    });

    test('ek hafta is within a week', () {
      final AvailabilityFreeText? parsed =
          parseAvailabilityFreeText('ek hafte mein');
      expect(parsed, isNotNull);
      expect(parsed!.status, 'within_week');
    });

    test('turant is immediate', () {
      final AvailabilityFreeText? parsed =
          parseAvailabilityFreeText('turant join kar sakta hu');
      expect(parsed, isNotNull);
      expect(parsed!.status, 'immediate');
    });

    test('rubbish keeps empty', () {
      expect(parseAvailabilityFreeText('asdfgh qwerty'), isNull);
      expect(parseAvailabilityFreeText('pata nahi bhai'), isNull);
      expect(parseAvailabilityFreeText(''), isNull);
      expect(parseAvailabilityFreeText('   '), isNull);
    });

    test('tenure is not a notice (lagbhag guard)', () {
      expect(
        parseAvailabilityFreeText('lagbhag 8 mahine se kaam kar raha hoon'),
        isNull,
      );
      expect(parseAvailabilityFreeText('6 mahine ka experience hai'), isNull);
    });

    test('sava / paune fractions resolve to months', () {
      final AvailabilityFreeText? sava =
          parseAvailabilityFreeText('sava mahina');
      expect(sava, isNotNull);
      expect(sava!.status, 'serving_notice');
      expect(sava.noticeDays, 38);

      final AvailabilityFreeText? paune =
          parseAvailabilityFreeText('paune do mahine');
      expect(paune, isNotNull);
      expect(paune!.status, 'serving_notice');
      expect(paune.noticeDays, 53);
    });
  });
}
