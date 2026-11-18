import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/trade_form/domain/form_fact_registry.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_topics.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

import 'form_pack_corpus.dart';

/// #2748 item 8a — every FORM-ENABLED launch trade asks a LEVEL and a YEARS
/// band on the trade form, so each one can be set on a profile.
///
/// Read from the SHIPPED packs (`form_pack_corpus.dart`), never a hand-kept
/// copy: `packages/db/data/question-packs/**` is in ci.yml's
/// `worker-app-parity` filter, so a pack PR that drops or gates one of these
/// questions goes red on that PR.
///
/// PROVEN ON BOTH SIDES OF THE WIRE:
///  * the PACK — the active, form-served version asks both questions, at the
///    lowest tier (`easy`; tiers are cumulative, so every tier asks them) and
///    with no `ask_if` / `skip_if` / parent, which the server's
///    `isFormQuestionVisible` always shows; the years answer is a closed set of
///    numbers and the level a closed set of rungs;
///  * the APP — the trade form keeps both: its one-fact guard
///    ([dedupeTradeForm]) never drops either, even for a worker whose tenure
///    the chat already recorded, and both are labelled as Experience.
///
/// 3D CAD designer is NOT here: its role has no form yet (chat interview only,
/// `formEnabled: false`), which is #2753's to change (#2748 item 8b).
class _LaunchTrade {
  const _LaunchTrade(
    this.name,
    this.packId, {
    required this.levelKey,
    required this.yearsKey,
  });

  final String name;
  final String packId;

  /// The trade's own rung question (Helper / Operator / ...).
  final String levelKey;

  /// The trade's own tenure question (the years band).
  final String yearsKey;
}

const List<_LaunchTrade> _kLaunchTrades = <_LaunchTrade>[
  _LaunchTrade(
    'CNC turner',
    'qp_cnc_turning',
    levelKey: 'turning_level',
    yearsKey: 'turning_experience',
  ),
  _LaunchTrade(
    'VMC / machining centre',
    'qp_vmc_milling',
    levelKey: 'milling_level',
    yearsKey: 'milling_experience',
  ),
  _LaunchTrade(
    'CAM programmer',
    'qp_cam_programming',
    levelKey: 'cam_level',
    yearsKey: 'programming_experience',
  ),
  _LaunchTrade(
    'Sheet metal',
    'qp_sheet_metal_fab',
    levelKey: 'sheet_metal_level',
    yearsKey: 'sheet_metal_experience',
  ),
];

/// The lowest profiling tier. Tiers are cumulative, so a question tagged
/// with it is asked on Easy, Medium and Hard alike.
const String _kLowestTier = 'easy';

TradeFormQuestionStep _q(String key) => TradeFormQuestionStep(
  question: VoiceQuestion(id: key, prompt: 'prompt for $key'),
  searchable: false,
);

void main() {
  final Map<String, ShippedPack> formPacks = readFormPacks();

  test('the launch trades are known form trades', () {
    expect(
      kKnownFormPackIds,
      containsAll(<String>[
        for (final _LaunchTrade t in _kLaunchTrades) t.packId,
      ]),
    );
  });

  for (final _LaunchTrade trade in _kLaunchTrades) {
    group('${trade.name} (${trade.packId})', () {
      ShippedPack pack() {
        final ShippedPack? found = formPacks[trade.packId];
        expect(
          found,
          isNotNull,
          reason:
              '${trade.packId} is not served by the trade form '
              '(missing, inactive, or lost its tier tags)',
        );
        return found!;
      }

      Map<String, dynamic> item(String key) {
        final ShippedPack p = pack();
        final Map<String, dynamic>? found = p.item(key);
        expect(
          found,
          isNotNull,
          reason: '${p.packId}@${p.version} no longer asks $key',
        );
        return found!;
      }

      test('asks the level and the years band', () {
        expect(
          pack().questionKeys,
          containsAll(<String>[trade.levelKey, trade.yearsKey]),
        );
      });

      test('asks both at every tier, with no gate', () {
        for (final String key in <String>[trade.levelKey, trade.yearsKey]) {
          final Map<String, dynamic> i = item(key);
          expect(i['min_tier'], _kLowestTier, reason: key);
          expect(i['ask_if'], isNull, reason: '$key must not be gated');
          expect(i['skip_if'], isNull, reason: '$key must not be skippable');
          expect(
            i['parent_item_key'],
            isNull,
            reason: '$key must not hang off another question',
          );
        }
      });

      test('the years band is a closed set of numbers', () {
        final Map<String, dynamic> years = item(trade.yearsKey);
        expect(years['answer_type'], 'single_select');
        final List<dynamic> options = years['options'] as List<dynamic>;
        expect(options, isNotEmpty);
        for (final dynamic raw in options) {
          final Map<String, dynamic> option = raw as Map<String, dynamic>;
          // A number ONLY: a `value_text` beside it would store a string and
          // leave every `gte` gate on this question unanswerable.
          expect(
            option['value_number'],
            isA<num>(),
            reason: '${trade.yearsKey}.${option['option_key']}',
          );
          expect(
            (option['value_number'] as num) >= 0,
            isTrue,
            reason: '${trade.yearsKey}.${option['option_key']}',
          );
          expect(
            option['value_text'],
            isNull,
            reason: '${trade.yearsKey}.${option['option_key']}',
          );
        }
      });

      test('the level is a closed set of rungs', () {
        final Map<String, dynamic> level = item(trade.levelKey);
        expect(level['answer_type'], 'single_select');
        final List<dynamic> options = level['options'] as List<dynamic>;
        expect(options.length, greaterThan(1));
        for (final dynamic raw in options) {
          final Map<String, dynamic> option = raw as Map<String, dynamic>;
          expect(
            option['value_text'],
            isA<String>(),
            reason: '${trade.levelKey}.${option['option_key']}',
          );
          expect(
            (option['value_text'] as String).trim(),
            isNotEmpty,
            reason: '${trade.levelKey}.${option['option_key']}',
          );
          expect(
            (option['label_text'] as String?)?.trim(),
            isNotEmpty,
            reason: '${trade.levelKey}.${option['option_key']}',
          );
        }
      });

      test('the app labels both as Experience', () {
        expect(knownFormTopicFor(trade.levelKey), (
          'Experience',
          'Skill level',
        ));
        expect(knownFormTopicFor(trade.yearsKey), (
          'Experience',
          'Work experience',
        ));
        expect(tradeFormQuestionFact(trade.yearsKey), WorkerFact.tradeTenure);
        expect(
          tradeFormQuestionFact(trade.levelKey),
          isNull,
          reason:
              'a trade-specific question is never dropped as a known '
              'fact',
        );
      });

      test('the trade form keeps both, even when the tenure is known', () {
        final ShippedPack p = pack();
        // The universal tenure question first, as the deployed API appends
        // it, then the pack's own questions in pack order.
        final TradeForm form = TradeForm(
          kind: trade.packId,
          packId: p.packId,
          packVersion: p.version,
          sections: <TradeFormSection>[
            TradeFormSection(
              id: 'capability',
              title: 'Capability',
              screens: <TradeFormStep>[
                _q(kUniversalTenureQuestionKey),
                for (final String key in p.questionKeys) _q(key),
              ],
            ),
          ],
        );

        final List<String> kept =
            dedupeTradeForm(
                  form,
                  knownFacts: const <WorkerFact>{WorkerFact.tradeTenure},
                ).questionSteps
                .map((TradeFormQuestionStep q) => q.question.id)
                .toList();

        expect(kept, containsAll(<String>[trade.levelKey, trade.yearsKey]));
        expect(
          kept,
          isNot(contains(kUniversalTenureQuestionKey)),
          reason: "the pack's own years question replaces the universal one",
        );
      });
    });
  }
}
