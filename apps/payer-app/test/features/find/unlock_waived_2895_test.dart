import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/find/presentation/widgets/unlock_button.dart';

/// #2750 part C — the app reads the waiver marker and names it on the open button.
void main() {
  test('the wire marker becomes a waived worker', () {
    final UnlockQuotes? quotes = UnlockQuotes.tryFromJson(<String, dynamic>{
      'quotes': <Map<String, dynamic>>[
        <String, dynamic>{'worker_id': 'w1', 'credits': 0, 'waived': true},
        <String, dynamic>{'worker_id': 'w2', 'credits': 1},
      ],
      'credits_available': 3,
    });
    expect(quotes, isNotNull);
    expect(quotes!.waivedFor('w1'), isTrue);
    expect(quotes.waivedFor('w2'), isFalse);
  });

  test('the open button names the waiver instead of a price', () {
    expect(unlockCtaLabel(0, waived: true), 'Free: RVM placement team');
    expect(unlockCtaLabel(2), 'Open for 2 credits');
  });
}
