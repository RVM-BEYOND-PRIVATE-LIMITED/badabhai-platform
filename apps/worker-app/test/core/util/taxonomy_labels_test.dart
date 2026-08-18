import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/taxonomy_labels.dart';

/// TD-02/TD-03 (see docs/registers/taxonomy-decisions/phase-8-taxonomy-decisions.md)
/// dissolved `skill_boring` into `skill_turning` and `skill_dimensional_inspection`
/// into `skill_quality_control`. Backend drops the old ids from the corpus, but
/// historical worker data may still carry them. The client must never show a
/// blank or raw id for a dissolved id — it should fall back to the same
/// prettified label the id-shaped-but-unknown path already produces.
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
  });
}
