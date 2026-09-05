import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';

void main() {
  group('TradeFormEmploymentEntry.toJson', () {
    test('title-cases employer_name and role_label, never work_done', () {
      const TradeFormEmploymentEntry entry = TradeFormEmploymentEntry(
        employerName: 'recursive global infotech pvt ltd',
        roleLabel: 'cnc turning',
        workDone: 'naye parts banate the aur quality check karte the',
      );

      final Map<String, dynamic> json = entry.toJson();

      expect(json['employer_name'], 'Recursive Global Infotech Pvt Ltd');
      expect(json['role_label'], 'Cnc Turning');
      // Free text the worker wrote in their own words — never touched.
      expect(json['work_done'],
          'naye parts banate the aur quality check karte the');
    });

    test('an already-correct abbreviation survives untouched', () {
      const TradeFormEmploymentEntry entry = TradeFormEmploymentEntry(
        employerName: 'RVM CAD Pvt Ltd',
        roleLabel: 'CNC Operator',
      );

      final Map<String, dynamic> json = entry.toJson();

      expect(json['employer_name'], 'RVM CAD Pvt Ltd');
      expect(json['role_label'], 'CNC Operator');
    });
  });
}
