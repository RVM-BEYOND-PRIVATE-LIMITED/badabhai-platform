import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/trade_form/domain/profiling_tier.dart';

/// #1698 — the WIRE CONTRACT of tiered profiling, pinned as literals.
///
/// SOURCE OF TRUTH: `PROFILING_TIERS`, `TierStateResponse`, `ChooseTierSchema`
/// and `ChooseTierResponse` in `packages/types` / `apps/api/src/profiling`. If
/// a token is renamed there, this file must go red in the same PR.
///
/// The literals are spelled out here rather than read back off the enum: a test
/// that feeds its own constant to its own parser agrees with itself whatever
/// the server says. That is the `worker-app-action-contract` lesson — a Dart
/// assertion against a mock that answers 200 to anything proved nothing while
/// `source_surface: 'voice_form'` 400'd on every real request. A Dart-only test
/// cannot close that gap by itself; the cross-language half (a TS test that
/// reads this client) is backend-owned under CLAUDE.md §6.
void main() {
  group('the three tier tokens', () {
    test('parse to their own member, in the server\'s own order', () {
      expect(profilingTierFrom('easy'), ProfilingTier.easy);
      expect(profilingTierFrom('medium'), ProfilingTier.medium);
      expect(profilingTierFrom('hard'), ProfilingTier.hard);
      expect(ProfilingTier.values, <ProfilingTier>[
        ProfilingTier.easy,
        ProfilingTier.medium,
        ProfilingTier.hard,
      ]);
    });

    test('serialise back to the exact tokens POST /profiling/form/tier takes',
        () {
      expect(profilingTierWire(ProfilingTier.easy), 'easy');
      expect(profilingTierWire(ProfilingTier.medium), 'medium');
      expect(profilingTierWire(ProfilingTier.hard), 'hard');
    });

    test('an unknown / absent / malformed tier is NULL, never guessed', () {
      expect(profilingTierFrom('expert'), isNull);
      expect(profilingTierFrom(null), isNull);
      expect(profilingTierFrom(3), isNull);
      expect(profilingTierFrom(''), isNull);
    });
  });

  group('GET /profiling/form/tiers', () {
    Map<String, dynamic> body({
      bool enabled = true,
      bool needsChoice = true,
      Object? currentTier,
      List<String> upgradableTo = const <String>[],
      List<Map<String, dynamic>>? tiers,
    }) => <String, dynamic>{
      'enabled': enabled,
      'kind': 'cnc_turner',
      'needs_choice': needsChoice,
      'current_tier': currentTier,
      'upgradable_to': upgradableTo,
      'tiers': tiers ??
          <Map<String, dynamic>>[
            <String, dynamic>{
              'tier': 'easy',
              'min_minutes': 2,
              'max_minutes': 3,
              'question_count': 6,
            },
            <String, dynamic>{
              'tier': 'medium',
              'min_minutes': 5,
              'max_minutes': 7,
              'question_count': 14,
            },
            <String, dynamic>{
              'tier': 'hard',
              'min_minutes': 10,
              'max_minutes': 12,
              'question_count': 23,
            },
          ],
    };

    test('a full enabled body parses every field', () {
      final TierState s = TierState.fromJson(body());
      expect(s.enabled, isTrue);
      expect(s.kind, 'cnc_turner');
      expect(s.needsChoice, isTrue);
      expect(s.currentTier, isNull);
      expect(s.tiers.map((TierEstimate e) => e.tier), <ProfilingTier>[
        ProfilingTier.easy,
        ProfilingTier.medium,
        ProfilingTier.hard,
      ]);
      expect(s.tiers.first.minMinutes, 2);
      expect(s.tiers.first.maxMinutes, 3);
      expect(s.tiers.first.questionCount, 6);
      expect(s.shouldChooseTier, isTrue);
    });

    test('enabled:false collapses to `disabled` — no tier UI may render', () {
      final TierState s = TierState.fromJson(body(enabled: false));
      expect(s, TierState.disabled);
      expect(s.shouldChooseTier, isFalse);
      expect(s.canUpgrade, isFalse);
    });

    test('a non-map body (an older server, a truncated response) is disabled',
        () {
      expect(TierState.fromJson(null), TierState.disabled);
      expect(TierState.fromJson('nope'), TierState.disabled);
      expect(TierState.fromJson(<String, dynamic>{}), TierState.disabled);
    });

    test('needs_choice:false does NOT show the screen even when enabled', () {
      final TierState s = TierState.fromJson(
        body(needsChoice: false, currentTier: 'hard'),
      );
      expect(s.enabled, isTrue);
      expect(s.currentTier, ProfilingTier.hard);
      expect(s.shouldChooseTier, isFalse);
    });

    test('an enabled body with NO usable cards does not show the screen', () {
      final TierState s = TierState.fromJson(
        body(tiers: <Map<String, dynamic>>[]),
      );
      expect(s.enabled, isTrue);
      expect(s.shouldChooseTier, isFalse,
          reason: 'a chooser with nothing to choose from is a dead screen');
    });

    test('a tier row this build does not know is DROPPED, not drawn', () {
      final TierState s = TierState.fromJson(
        body(tiers: <Map<String, dynamic>>[
          <String, dynamic>{
            'tier': 'easy',
            'min_minutes': 2,
            'max_minutes': 3,
          },
          <String, dynamic>{
            'tier': 'legendary',
            'min_minutes': 40,
            'max_minutes': 60,
          },
        ]),
      );
      expect(s.tiers.map((TierEstimate e) => e.tier),
          <ProfilingTier>[ProfilingTier.easy]);
    });

    test('a row with unusable minutes is dropped — the app never invents a '
        'time', () {
      final TierState s = TierState.fromJson(
        body(tiers: <Map<String, dynamic>>[
          <String, dynamic>{'tier': 'easy'},
          <String, dynamic>{
            'tier': 'medium',
            'min_minutes': 0,
            'max_minutes': 7,
          },
          <String, dynamic>{
            'tier': 'hard',
            'min_minutes': 10,
            'max_minutes': 12,
          },
        ]),
      );
      expect(s.tiers.map((TierEstimate e) => e.tier),
          <ProfilingTier>[ProfilingTier.hard]);
    });

    test('upgradable_to drives "Add more detail", and only for tiers the '
        'server also priced', () {
      final TierState s = TierState.fromJson(
        body(
          needsChoice: false,
          currentTier: 'easy',
          upgradableTo: <String>['medium', 'hard'],
        ),
      );
      expect(s.canUpgrade, isTrue);
      expect(s.upgradeOptions.map((TierEstimate e) => e.tier),
          <ProfilingTier>[ProfilingTier.medium, ProfilingTier.hard]);
    });

    test('at Hard there is nothing to upgrade to', () {
      final TierState s = TierState.fromJson(
        body(needsChoice: false, currentTier: 'hard'),
      );
      expect(s.canUpgrade, isFalse);
      expect(s.upgradeOptions, isEmpty);
    });
  });

  group('POST /profiling/form/tier', () {
    TierChoice? parse(Object? change, {Object? previous}) =>
        TierChoice.fromJson(<String, dynamic>{
          'tier': 'medium',
          'previous_tier': previous,
          'change': change,
        });

    test('the three change tokens', () {
      expect(parse('selected')!.change, TierChange.selected);
      expect(parse('upgraded')!.change, TierChange.upgraded);
      expect(parse('unchanged')!.change, TierChange.unchanged);
    });

    test('ONLY an upgrade asks for the narrowed form view', () {
      expect(parse('upgraded')!.needsUpgradeView, isTrue);
      expect(parse('selected')!.needsUpgradeView, isFalse);
      expect(parse('unchanged')!.needsUpgradeView, isFalse);
    });

    test('an unknown change reads as `unchanged` — the arm that opens the '
        'ordinary full form', () {
      expect(parse('rewritten')!.change, TierChange.unchanged);
      expect(parse(null)!.change, TierChange.unchanged);
    });

    test('previous_tier round-trips, including null on a first selection', () {
      expect(parse('selected')!.previousTier, isNull);
      expect(parse('upgraded', previous: 'easy')!.previousTier,
          ProfilingTier.easy);
    });

    test('a body with no usable tier is null — the app does not invent a '
        'confirmation the server did not give', () {
      expect(TierChoice.fromJson(<String, dynamic>{'change': 'selected'}),
          isNull);
      expect(TierChoice.fromJson('nope'), isNull);
      expect(TierChoice.fromJson(null), isNull);
    });
  });
}
