import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_topics.dart';

import 'form_pack_corpus.dart';

/// ── THE GUARD: every question the trade form can serve has a topic ────────
///
/// `trade_form_topics.dart` is the Technical Skills walk's keep/drop source,
/// and the walk FAILS CLOSED on a key the table does not know
/// (`trade_form_section_walk.dart`). So an unmapped key in a shipped form pack
/// is a question silently missing from that trade's Technical Skills walk —
/// and, before the walk failed closed, a question silently ADDED to it (how
/// seven trades' tenure and self-level questions got there).
///
/// This reads the SHIPPED packs (`form_pack_corpus.dart`), so it goes red on
/// the PR that adds the key, not on whichever app PR happens to come next:
/// `packages/db/data/question-packs/**` is in ci.yml's `worker-app-parity`
/// filter for exactly this file.
///
/// TO FIX A RED HERE: add the key to `_kTopics` with its TRUE category —
/// tenure/level → `Experience` (left out of Technical Skills), sector →
/// `Industry`, ITI/trade test → `Training`, and anything that describes the
/// worker's craft → a capability category (kept).
void main() {
  final Map<String, ShippedPack> formPacks = readFormPacks();

  test('the corpus scan finds every known form pack, each with questions', () {
    // Non-vacuity: a scan that found nothing would pass the check below.
    expect(formPacks.keys.toSet(), containsAll(kKnownFormPackIds),
        reason: 'a known form pack is missing, inactive or lost its tier tags');
    for (final String packId in kKnownFormPackIds) {
      expect(formPacks[packId]!.questionKeys, isNotEmpty, reason: packId);
    }
  });

  test('every question key a form pack ships is in the topics table', () {
    final Map<String, List<String>> unmapped = <String, List<String>>{
      for (final ShippedPack pack in formPacks.values)
        if (pack.questionKeys.any((String k) => knownFormTopicFor(k) == null))
          '${pack.packId}@${pack.version}': <String>[
            for (final String key in pack.questionKeys)
              if (knownFormTopicFor(key) == null) key,
          ],
    };

    expect(unmapped, isEmpty,
        reason: 'add these keys to _kTopics in trade_form_topics.dart with '
            'their TRUE category (see this file\'s doc): $unmapped');
  });

  test('a known key reads the same through both accessors', () {
    // The display fallback is for keys the table does NOT know; a known key's
    // header must be exactly the category the walk decides on.
    for (final ShippedPack pack in formPacks.values) {
      for (final String key in pack.questionKeys) {
        expect(formTopicFor(key), knownFormTopicFor(key), reason: key);
      }
    }
  });
}
