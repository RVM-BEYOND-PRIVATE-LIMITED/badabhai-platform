import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Layer A (c) — the extended work-preference fields on the SAME
/// `PUT /workers/me/work-preferences` body.
///
/// `apps/api/src/profiles/finishing-form-contract.test.ts` reads this file's
/// `toUpdateBody()` SOURCE and asserts each new key is reachable. These tests
/// assert the runtime behaviour the source read cannot: the three-state rule
/// (absent = leave alone) holds for every new field, and an empty list / false
/// is a real withdrawal rather than an omission.
void main() {
  group('WorkPreferences Layer A (c) extensions', () {
    test('an untouched preferences body sends NONE of the new keys', () {
      const WorkPreferences prefs = WorkPreferences();
      final Map<String, dynamic> body = prefs.toUpdateBody();
      expect(body.containsKey('work_types'), isFalse);
      expect(body.containsKey('salary_period'), isFalse);
      expect(body.containsKey('commute_max_km'), isFalse);
      expect(body.containsKey('willing_to_travel'), isFalse);
      expect(body.containsKey('availability'), isFalse);
    });

    test('a touched work_types list is sent, and [] clears it', () {
      final WorkPreferences cleared =
          const WorkPreferences().copyWith(workTypes: <String>{});
      expect(cleared.toUpdateBody()['work_types'], isEmpty);

      final WorkPreferences picked = const WorkPreferences()
          .copyWith(workTypes: <String>{'permanent', 'daily_wage'});
      expect(
        picked.toUpdateBody()['work_types'],
        <String>['permanent', 'daily_wage'],
      );
    });

    test('a chosen salary_period and commute_max_km are sent', () {
      final WorkPreferences prefs = const WorkPreferences().copyWith(
        salaryPeriod: 'day',
        commuteMaxKm: 35,
      );
      final Map<String, dynamic> body = prefs.toUpdateBody();
      expect(body['salary_period'], 'day');
      expect(body['commute_max_km'], 35);
    });

    test('a touched willing_to_travel is a real bool, false included', () {
      final WorkPreferences no =
          const WorkPreferences().copyWith(willingToTravel: false);
      expect(no.toUpdateBody()['willing_to_travel'], isFalse);

      final WorkPreferences yes =
          const WorkPreferences().copyWith(willingToTravel: true);
      expect(yes.toUpdateBody()['willing_to_travel'], isTrue);
    });

    test('a touched availability sends the object, every key present', () {
      final WorkPreferences prefs = const WorkPreferences().copyWith(
        availability: const AvailabilityDraft(
          status: 'notice_period',
          availableFrom: '2026-10-01',
          noticePeriodDays: 30,
        ),
      );
      expect(prefs.toUpdateBody()['availability'], <String, dynamic>{
        'status': 'notice_period',
        'available_from': '2026-10-01',
        'notice_period_days': 30,
      });
    });

    test('clearing availability sends null, not an absent key', () {
      final WorkPreferences prefs = const WorkPreferences()
          .copyWith(availability: null);
      final Map<String, dynamic> body = prefs.toUpdateBody();
      expect(body.containsKey('availability'), isTrue);
      expect(body['availability'], isNull);
    });
  });
}
