import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Review round 1: `PUT /workers/me/work-preferences` clears a key sent as `[]`
/// and leaves an ABSENT key alone. Both preference pages open blank (there is
/// no read route), so an untouched field must never be sent.
void main() {
  group('TradeFormPreferences.toJson — only what the worker touched', () {
    test('an untouched page sends nothing', () {
      expect(const TradeFormPreferences().toJson(), isEmpty);
    });

    test('a touched list or yes/no is sent, even when emptied again', () {
      final TradeFormPreferences prefs = const TradeFormPreferences()
          .copyWith(languages: <String>{'hindi'})
          .copyWith(languages: <String>{})
          .copyWith(willingToRelocate: true);

      expect(prefs.toJson(), <String, dynamic>{
        'languages': <String>[],
        'willing_to_relocate': true,
      });
    });

    test('scalars keep their rule: sent only when chosen', () {
      final Map<String, dynamic> body = const TradeFormPreferences()
          .copyWith(shift: 'day', salaryExpectedMax: 20000)
          .toJson();

      expect(body, <String, dynamic>{'shift': 'day', 'salary_expected_max': 20000});
    });
  });

  group('WorkPreferences.toUpdateBody — only what the worker touched', () {
    test('an untouched form sends nothing', () {
      expect(const WorkPreferences().toUpdateBody(), isEmpty);
    });

    test('a touched city list is sent', () {
      final Map<String, dynamic> body = const WorkPreferences()
          .copyWith(preferredCities: <String>['Pune'])
          .toUpdateBody();

      expect(body, <String, dynamic>{
        'preferred_cities': <String>['Pune'],
      });
    });
  });
}
