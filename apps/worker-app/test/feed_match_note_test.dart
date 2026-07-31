import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';

/// Matching V1 / E18 (ADR-0036) — the feed card's "why am I seeing this" line.
///
/// TWO PROPERTIES, both of which fail SILENTLY if broken. The parse has to treat
/// the LEGACY wire shape (no `via_related`, no `matched_skill_label`) as "not
/// related" rather than crashing or defaulting to related — `MATCH_V1_ENABLED`
/// is a server flag and the same build must handle both, in both directions.
/// And the note has to stay absent unless we can actually name the skill, so the
/// card never explains itself with a sentence that says nothing.
Map<String, dynamic> _job({
  bool? viaRelated,
  String? matchedSkillLabel,
  bool includeV1Keys = true,
}) {
  return <String, dynamic>{
    'job_id': 'j1',
    'trade_key': 'cnc_operator',
    'title': 'CNC Operator',
    'city': 'Pune',
    'area': null,
    'rank': 1,
    if (includeV1Keys) 'via_related': viaRelated,
    if (includeV1Keys) 'matched_skill_label': matchedSkillLabel,
  };
}

void main() {
  group('FeedItem.fromJson — the ADR-0036 keys are ADDITIVE', () {
    test('the LEGACY shape (keys absent entirely) parses as NOT related', () {
      final FeedItem item = FeedItem.fromJson(_job(includeV1Keys: false));
      expect(item.viaRelated, isFalse);
      expect(item.matchedSkillLabel, isNull);
    });

    test('an explicit null via_related is not related either', () {
      final FeedItem item = FeedItem.fromJson(_job(viaRelated: null));
      expect(item.viaRelated, isFalse);
    });

    test('a V1 related row carries the flag and the closed-set label', () {
      final FeedItem item = FeedItem.fromJson(
        _job(viaRelated: true, matchedSkillLabel: 'VMC operating'),
      );
      expect(item.viaRelated, isTrue);
      expect(item.matchedSkillLabel, 'VMC operating');
    });
  });

  group('matchNoteFor — E18, only when there is something true to say', () {
    test('an EXACT match gets no note (it needs no explanation)', () {
      expect(
        matchNoteFor(FeedItem.fromJson(_job(viaRelated: false))),
        isNull,
      );
    });

    test('a RELATED match names the skill that earned it', () {
      final String? note = matchNoteFor(
        FeedItem.fromJson(_job(viaRelated: true, matchedSkillLabel: 'VMC operating')),
      );
      expect(note, 'Aapke VMC operating ke kaam se milta-julta hai.');
    });

    test('related but UNNAMED stays silent — a vague reason explains nothing', () {
      expect(
        matchNoteFor(FeedItem.fromJson(_job(viaRelated: true))),
        isNull,
      );
      expect(
        matchNoteFor(FeedItem.fromJson(_job(viaRelated: true, matchedSkillLabel: '   '))),
        isNull,
      );
    });

    test('the note obeys the worker persona: aap-form, no exclamation, no emoji', () {
      final String note = matchNoteFor(
        FeedItem.fromJson(_job(viaRelated: true, matchedSkillLabel: 'Grinding')),
      )!;
      expect(note.toLowerCase(), contains('aap'));
      expect(note, isNot(contains('!')));
      // Whole-word check: the banned informal address, not a substring of a word.
      expect(RegExp(r'\b(tu|tum|tumhara|tumhe)\b').hasMatch(note.toLowerCase()), isFalse);
      expect(RegExp(r'\b(bhai|bhaiya|beta|behen|yaar)\b').hasMatch(note.toLowerCase()), isFalse);
    });
  });
}
