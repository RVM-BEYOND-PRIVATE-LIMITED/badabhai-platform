import 'package:flutter_test/flutter_test.dart';
import 'package:payer_app/core/data/models.dart';

/// #2750 part D — the two opening-limit answers.
void main() {
  test('week and day limits are distinguishable and charge nothing', () {
    const UnlockResult week = UnlockResult.weekLimit();
    const UnlockResult day = UnlockResult.dailyLimitReached(40);
    expect(week.weekLimitReached, isTrue);
    expect(week.granted, isFalse);
    expect(week.creditsCharged, isNull);
    expect(day.dailyLimitReached, isTrue);
    expect(day.dailyLimit, 40);
    expect(day.granted, isFalse);
  });
}
