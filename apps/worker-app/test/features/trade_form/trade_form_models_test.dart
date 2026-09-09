import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';

void main() {
  // #1472 — the spoken work description. The clip id is PROVENANCE for the
  // text; the server refuses one without the other and refuses the WHOLE
  // submission, so the client must never put it on the wire alone.
  group('TradeFormEmploymentEntry.toJson — work_done_voice_note_id', () {
    test('rides along when there IS a description', () {
      const TradeFormEmploymentEntry entry = TradeFormEmploymentEntry(
        employerName: 'acme tools',
        roleLabel: 'cnc turner',
        workDone: 'Fanuc setting aur programming',
        workDoneVoiceNoteId: '11111111-2222-3333-4444-555555555555',
      );

      final Map<String, dynamic> json = entry.toJson();
      expect(json['work_done'], 'Fanuc setting aur programming');
      expect(json['work_done_voice_note_id'],
          '11111111-2222-3333-4444-555555555555');
    });

    test('is DROPPED when the worker clears the description', () {
      // The whole submission would 400 otherwise, losing the entire work
      // history over a cleared text box.
      const TradeFormEmploymentEntry entry = TradeFormEmploymentEntry(
        employerName: 'acme tools',
        roleLabel: 'cnc turner',
        workDone: '   ',
        workDoneVoiceNoteId: '11111111-2222-3333-4444-555555555555',
      );

      final Map<String, dynamic> json = entry.toJson();
      expect(json['work_done'], isNull);
      expect(json['work_done_voice_note_id'], isNull);
    });

    test('is null when the worker typed instead of speaking', () {
      const TradeFormEmploymentEntry entry = TradeFormEmploymentEntry(
        employerName: 'acme tools',
        roleLabel: 'cnc turner',
        workDone: 'Typed by hand',
      );

      expect(entry.toJson()['work_done_voice_note_id'], isNull);
    });

    test('copyWith can clear it back to null', () {
      const TradeFormEmploymentEntry entry = TradeFormEmploymentEntry(
        employerName: 'acme tools',
        roleLabel: 'cnc turner',
        workDone: 'Spoken',
        workDoneVoiceNoteId: '11111111-2222-3333-4444-555555555555',
      );

      expect(entry.copyWith(workDoneVoiceNoteId: null).workDoneVoiceNoteId,
          isNull);
      // and is preserved when untouched
      expect(entry.copyWith(workDone: 'Edited').workDoneVoiceNoteId,
          '11111111-2222-3333-4444-555555555555');
    });
  });

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
