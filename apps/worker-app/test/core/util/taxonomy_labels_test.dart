import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/taxonomy_labels.dart';

/// TD-02/TD-03 (see docs/registers/taxonomy-decisions/phase-8-taxonomy-decisions.md)
/// dissolved `skill_boring` into `skill_turning` and `skill_dimensional_inspection`
/// into `skill_quality_control`. Backend drops the old ids from the corpus, but
/// historical worker data may still carry them. The client must never show a
/// blank or raw id for a dissolved id — it should fall back to the same
/// prettified label the id-shaped-but-unknown path already produces.
///
/// TD-01 (GitHub #936) fully dissolves `skill_gdt_reading` AND
/// `skill_cad_interpretation` into a brand-new active skill,
/// `skill_drawing_reading` — neither old id survives. Unlike TD-02/TD-03,
/// the merge target is new (not a pre-existing labelled skill), so it gets
/// an explicit label in `_kSkillLabels` rather than relying on `_prettify()`.
void main() {
  group('taxonomyLabel', () {
    test('dissolved id skill_boring falls back to a prettified label, not '
        'blank or raw', () {
      final String label = taxonomyLabel('skill_boring');
      expect(label, isNotEmpty);
      expect(label, isNot('skill_boring'));
      expect(label, 'Boring');
    });

    test(
        'dissolved id skill_dimensional_inspection falls back to a '
        'prettified label, not blank or raw', () {
      final String label = taxonomyLabel('skill_dimensional_inspection');
      expect(label, isNotEmpty);
      expect(label, isNot('skill_dimensional_inspection'));
      expect(label, 'Dimensional Inspection');
    });

    test('merge target skill_turning is unaffected', () {
      expect(taxonomyLabel('skill_turning'), 'Turning (lathe operation)');
    });

    test('merge target skill_quality_control is unaffected', () {
      expect(
          taxonomyLabel('skill_quality_control'), 'Quality control (QC)');
    });

    test('an unrelated known skill id still resolves from the map', () {
      expect(taxonomyLabel('skill_milling'), 'Milling');
    });

    test('a non-id-shaped string is returned unchanged', () {
      expect(taxonomyLabel('Not a taxonomy id'), 'Not a taxonomy id');
    });

    test('dissolved id skill_gdt_reading falls back to a prettified label, '
        'not blank or raw', () {
      final String label = taxonomyLabel('skill_gdt_reading');
      expect(label, isNotEmpty);
      expect(label, isNot('skill_gdt_reading'));
      expect(label, 'GDT Reading');
    });

    test(
        'dissolved id skill_cad_interpretation falls back to a '
        'prettified label, not blank or raw', () {
      final String label = taxonomyLabel('skill_cad_interpretation');
      expect(label, isNotEmpty);
      expect(label, isNot('skill_cad_interpretation'));
      expect(label, 'Cad Interpretation');
    });

    test('merge target skill_drawing_reading resolves to its explicit '
        'label', () {
      expect(taxonomyLabel('skill_drawing_reading'),
          'GD&T / technical drawing reading');
    });
  });

  group('replaceTaxonomyIds', () {
    test('dissolved ids embedded in text are prettified, not left raw', () {
      expect(
        replaceTaxonomyIds('Skills: skill_boring, skill_turning'),
        'Skills: Boring, Turning (lathe operation)',
      );
      expect(
        replaceTaxonomyIds(
            'Inspects with skill_dimensional_inspection and '
            'skill_quality_control'),
        'Inspects with Dimensional Inspection and Quality control (QC)',
      );
    });

    test('TD-01 dissolved ids embedded in text are prettified; the new '
        'merge target resolves to its explicit label', () {
      expect(
        replaceTaxonomyIds(
            'Reads skill_gdt_reading and skill_cad_interpretation; now '
            'tracked as skill_drawing_reading'),
        'Reads GDT Reading and Cad Interpretation; now tracked as '
        'GD&T / technical drawing reading',
      );
    });
  });
}
