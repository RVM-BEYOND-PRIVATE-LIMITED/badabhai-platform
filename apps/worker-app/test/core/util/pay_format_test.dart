import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/pay_format.dart';

void main() {
  group('formatPayBandFull', () {
    test('both bounds → grouped band with /mo', () {
      expect(formatPayBandFull(16000, 26000), '₹16,000–26,000/mo');
    });

    test('equal bounds → single amount', () {
      expect(formatPayBandFull(20000, 20000), '₹20,000/mo');
    });

    test('min only → open-ended plus', () {
      expect(formatPayBandFull(16000, null), '₹16,000+/mo');
    });

    test('max only → honest "Up to"', () {
      expect(formatPayBandFull(null, 26000), 'Up to ₹26,000/mo');
    });

    test('neither → null so the caller HIDES the row', () {
      expect(formatPayBandFull(null, null), isNull);
    });

    test('groups Indian-style above a lakh', () {
      expect(formatPayBandFull(125000, null), '₹1,25,000+/mo');
    });

    test('a negative bound is contract-invalid and treated as absent', () {
      expect(formatPayBandFull(-1, null), isNull);
      expect(formatPayBandFull(-1, 26000), 'Up to ₹26,000/mo');
    });
  });

  group('formatPayBandCompact', () {
    test('both bounds → k-band (the deck card style)', () {
      expect(formatPayBandCompact(16000, 26000), '₹16k–26k');
    });

    test('equal bounds → single compact amount', () {
      expect(formatPayBandCompact(20000, 20000), '₹20k');
    });

    test('min only → plus', () {
      expect(formatPayBandCompact(16000, null), '₹16k+');
    });

    test('max only → "Up to"', () {
      expect(formatPayBandCompact(null, 26000), 'Up to ₹26k');
    });

    test('neither → null so the card row stays hidden', () {
      expect(formatPayBandCompact(null, null), isNull);
    });

    test('non-round thousands keep one decimal; sub-1000 stays plain', () {
      expect(formatPayBandCompact(16500, 26000), '₹16.5k–26k');
      expect(formatPayBandCompact(800, null), '₹800+');
    });

    test('a negative bound is treated as absent', () {
      expect(formatPayBandCompact(null, -5), isNull);
    });
  });

  group('formatIndianGrouped', () {
    test('groups last three then twos', () {
      expect(formatIndianGrouped(999), '999');
      expect(formatIndianGrouped(1000), '1,000');
      expect(formatIndianGrouped(16000), '16,000');
      expect(formatIndianGrouped(125000), '1,25,000');
      expect(formatIndianGrouped(12500000), '1,25,00,000');
    });
  });
}
