import 'package:flutter_test/flutter_test.dart';
import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/api/occupation_label.dart';

/// The universal-fallback occupation family ("सामान्य" / "General") must never
/// reach the profiling trust pill — it is hidden by nulling the label at the
/// parse boundary. Real trades pass through unchanged.
void main() {
  group('isUniversalOccupationLabel', () {
    test('matches the Hindi + English universal labels (trim + case)', () {
      expect(isUniversalOccupationLabel('सामान्य'), isTrue);
      expect(isUniversalOccupationLabel('  सामान्य  '), isTrue);
      expect(isUniversalOccupationLabel('General'), isTrue);
      expect(isUniversalOccupationLabel('general'), isTrue);
      expect(isUniversalOccupationLabel('  GENERAL '), isTrue);
      expect(isUniversalOccupationLabel(''), isTrue); // blank = nothing to show
      expect(isUniversalOccupationLabel('   '), isTrue);
    });

    test('does NOT match real trades', () {
      expect(isUniversalOccupationLabel(null), isFalse);
      expect(isUniversalOccupationLabel('खराद और सीएनसी'), isFalse); // Machining and CNC
      expect(isUniversalOccupationLabel('वेल्डिंग'), isFalse); // Welding
      expect(isUniversalOccupationLabel('CNC Operator'), isFalse);
      expect(isUniversalOccupationLabel('darzi'), isFalse);
    });
  });

  group('displayableOccupationLabel', () {
    test('drops the universal label to null, keeps real trades', () {
      expect(displayableOccupationLabel('सामान्य'), isNull);
      expect(displayableOccupationLabel('General'), isNull);
      expect(displayableOccupationLabel(null), isNull);
      expect(displayableOccupationLabel('खराद और सीएनसी'), 'खराद और सीएनसी');
      expect(displayableOccupationLabel('CNC Operator'), 'CNC Operator');
    });
  });

  group('ChatReply.fromJson hides the universal label', () {
    ChatReply parse(Object? occupationLabel) => ChatReply.fromJson(<String, dynamic>{
          'reply': 'ok',
          'occupation_label': occupationLabel,
        });

    test('universal "सामान्य" -> occupationLabel null (pill hidden)', () {
      expect(parse('सामान्य').occupationLabel, isNull);
    });

    test('universal "General" -> occupationLabel null', () {
      expect(parse('General').occupationLabel, isNull);
    });

    test('a real family label survives', () {
      expect(parse('खराद और सीएनसी').occupationLabel, 'खराद और सीएनसी');
    });

    test('absent -> null (unchanged)', () {
      expect(parse(null).occupationLabel, isNull);
    });
  });
}
