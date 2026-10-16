import 'package:badabhai_worker_app/features/trade_form/domain/form_fact_registry.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:flutter_test/flutter_test.dart';

import 'form_pack_corpus.dart';

/// Every question key the shipped form packs serve — read from the corpus
/// (`form_pack_corpus.dart`), never hand-kept: the hand-kept list that stood
/// here ("the nine live form packs", 94 keys) missed all 68 keys of the seven
/// form trades shipped 2026-09-24/25, so this registry's "never drop a real
/// question" check never covered them. The registry must never drop one of
/// them from a real form.
List<String> _formPackQuestionKeys() => <String>{
      for (final ShippedPack pack in readFormPacks().values)
        ...pack.questionKeys,
    }.toList()
      ..sort();

/// The eight `qp_universal@2` keys, in the order f455bb36 appends them.
const List<String> _kUniversalKeys = <String>[
  'primary_trade',
  'experience_years',
  'current_city',
  'salary_expected',
  'preferred_locations',
  'availability',
  'education',
  'shift_preference',
];

TradeFormQuestionStep _q(String key, {TradeFormSavedAnswer? answer}) =>
    TradeFormQuestionStep(
      question: VoiceQuestion(
        id: key,
        prompt: 'prompt for $key',
        kind: VoiceQuestionKind.open,
      ),
      searchable: false,
      answer: answer,
    );

TradeFormSection _section(String id, List<TradeFormStep> screens) =>
    TradeFormSection(id: id, title: 'Title $id', screens: screens);

TradeForm _formOf(List<TradeFormSection> sections) => TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 3,
      sessionId: 'session-1',
      sections: sections,
    );

List<String> _questionKeys(TradeForm form) =>
    form.questionSteps.map((TradeFormQuestionStep q) => q.question.id).toList();

List<TradeFormMarkerType> _markerTypes(TradeForm form) => <TradeFormMarkerType>[
      for (final TradeFormSection s in form.sections)
        for (final TradeFormStep step in s.screens)
          if (tradeFormMarkerTypeOf(step) != null) tradeFormMarkerTypeOf(step)!,
    ];

List<String> _sectionIds(TradeForm form) =>
    form.sections.map((TradeFormSection s) => s.id).toList();

/// The deployed shape: trade items, the universal append, then all three
/// markers (the qualifications section also holds a fresher ITI question).
TradeForm _deployedShape() => _formOf(<TradeFormSection>[
      _section('capability', <TradeFormStep>[
        _q('turning_experience'),
        _q('turning_machine'),
        _q('material_worked'),
        for (final String key in _kUniversalKeys) _q(key),
      ]),
      _section('terms', const <TradeFormStep>[TradeFormPreferencesStep()]),
      _section('work_history', const <TradeFormStep>[TradeFormEmploymentStep()]),
      _section('qualifications', <TradeFormStep>[
        _q('iti_project_work'),
        const TradeFormQualificationsStep(),
      ]),
    ]);

void main() {
  group('dedupeTradeForm — one fact, asked once', () {
    test(
        'the universal append after the trade items keeps availability and '
        'the not-yet-known current city; turning_experience stays and '
        'experience_years goes', () {
      final TradeForm out = dedupeTradeForm(_deployedShape());

      expect(_questionKeys(out), <String>[
        'turning_experience',
        'turning_machine',
        'material_worked',
        'current_city',
        'availability',
        'iti_project_work',
      ]);
      expect(_markerTypes(out), <TradeFormMarkerType>[
        TradeFormMarkerType.preferences,
        TradeFormMarkerType.employment,
        TradeFormMarkerType.qualifications,
      ]);
      expect(_sectionIds(out),
          <String>['capability', 'terms', 'work_history', 'qualifications']);
      // Identity and the #1472 session id ride through untouched.
      expect(out.kind, 'cnc_turner');
      expect(out.packId, 'qp_cnc_turning');
      expect(out.packVersion, 3);
      expect(out.sessionId, 'session-1');
    });

    test('a second preferences marker is dropped, and so is the section it '
        'leaves empty', () {
      final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[_q('turning_machine')]),
        _section('terms', const <TradeFormStep>[
          TradeFormPreferencesStep(),
          TradeFormPreferencesStep(),
        ]),
        _section('work_history', const <TradeFormStep>[TradeFormEmploymentStep()]),
        _section('terms_again', const <TradeFormStep>[TradeFormPreferencesStep()]),
      ]));

      expect(_markerTypes(out), <TradeFormMarkerType>[
        TradeFormMarkerType.preferences,
        TradeFormMarkerType.employment,
      ]);
      expect(_sectionIds(out), <String>['capability', 'terms', 'work_history']);
    });

    test(
        'with NO preferences marker, preferred_locations / salary / shift are '
        'the only place those facts are asked, so they stay', () {
      final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[
          _q('turning_experience'),
          for (final String key in _kUniversalKeys) _q(key),
        ]),
        _section('work_history', const <TradeFormStep>[TradeFormEmploymentStep()]),
      ]));

      expect(_questionKeys(out), <String>[
        'turning_experience',
        'current_city',
        'salary_expected',
        'preferred_locations',
        'availability',
        // No qualifications marker either, so education has no other home.
        'education',
        'shift_preference',
      ]);
    });

    test(
        'the trade is never asked inside a form; the current city only while '
        'it is not known (/name lets a worker skip it)', () {
      TradeForm form() => _formOf(<TradeFormSection>[
            _section('capability', <TradeFormStep>[
              _q('primary_trade'),
              _q('turning_machine'),
              _q('current_city'),
            ]),
          ]);

      expect(_questionKeys(dedupeTradeForm(form())),
          <String>['turning_machine', 'current_city']);
      expect(
          _questionKeys(dedupeTradeForm(form(),
              knownFacts: <WorkerFact>{WorkerFact.currentCity})),
          <String>['turning_machine']);
    });

    test(
        'experience_years goes and the pack tenure question stays, even when '
        'the universal one comes first', () {
      final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[
          _q('experience_years'),
          _q('turning_experience'),
          _q('turning_machine'),
        ]),
      ]));

      expect(_questionKeys(out),
          <String>['turning_experience', 'turning_machine']);
    });

    test('a fact the chat already recorded drops its question when no marker '
        'owns it', () {
      final TradeForm out = dedupeTradeForm(
        _formOf(<TradeFormSection>[
          _section('capability', <TradeFormStep>[
            _q('turning_machine'),
            _q('preferred_locations'),
            _q('salary_expected'),
          ]),
        ]),
        knownFacts: <WorkerFact>{WorkerFact.preferredCities},
      );

      expect(_questionKeys(out), <String>['turning_machine', 'salary_expected']);
    });

    test('a repeated question_key keeps the FIRST screen, answer and all', () {
      const TradeFormSavedAnswer saved = TradeFormSavedAnswer(
        status: TradeFormAnswerStatus.answered,
        optionKeys: <String>['cnc_lathe'],
      );
      final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[
          _q('turning_machine', answer: saved),
          _q('material_worked'),
        ]),
        _section('extra', <TradeFormStep>[_q('turning_machine')]),
      ]));

      expect(_questionKeys(out), <String>['turning_machine', 'material_worked']);
      expect(out.questionSteps.first.answer, saved);
      expect(_sectionIds(out), <String>['capability']);
    });

    test('chat-pack shift, language and relocation keys defer to the '
        'preferences marker', () {
      final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[
          _q('turning_machine'),
          _q('shift_work'),
          _q('night_work'),
          _q('language_spoken'),
          _q('relocation'),
        ]),
        _section('terms', const <TradeFormStep>[TradeFormPreferencesStep()]),
      ]));

      expect(_questionKeys(out), <String>['turning_machine']);
    });

    // Review round 2: the guard is not a closed list of today's nine packs.
    test(
        "a pack added later: its own '*_experience' tenure question is kept "
        'and the universal experience_years is dropped', () {
      final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[
          _q('fitting_experience'),
          _q('fitting_work'),
          _q('experience_years'),
        ]),
      ]));

      expect(_questionKeys(out), <String>['fitting_experience', 'fitting_work']);
      expect(tradeFormQuestionFact('fitting_experience'), WorkerFact.tradeTenure);
      expect(tradeFormQuestionFact('fitting_work'), isNull);
    });

    test('relocation_willingness defers to the preferences marker', () {
      final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[
          _q('turning_machine'),
          _q('relocation_willingness'),
        ]),
        _section('terms', const <TradeFormStep>[TradeFormPreferencesStep()]),
      ]));

      expect(_questionKeys(out), <String>['turning_machine']);
    });

    test('a form with nothing to drop comes back as the same instance', () {
      final TradeForm form = _formOf(<TradeFormSection>[
        _section('capability', <TradeFormStep>[
          _q('turning_experience'),
          _q('turning_machine'),
        ]),
        _section('terms', const <TradeFormStep>[TradeFormPreferencesStep()]),
      ]);

      expect(identical(dedupeTradeForm(form), form), isTrue);
    });

    test('the form-pack keys come from every known form pack', () {
      // Non-vacuity: an empty scan would pass the survival check below.
      expect(readFormPacks().keys.toSet(), containsAll(kKnownFormPackIds));
      expect(_formPackQuestionKeys(), isNotEmpty);
    });

    test(
        'every real form-pack question survives in a form carrying all three '
        'markers', () {
      for (final String key in _formPackQuestionKeys()) {
        final TradeForm out = dedupeTradeForm(_formOf(<TradeFormSection>[
          _section('capability', <TradeFormStep>[_q(key)]),
          _section('terms', const <TradeFormStep>[TradeFormPreferencesStep()]),
          _section(
              'work_history', const <TradeFormStep>[TradeFormEmploymentStep()]),
          _section('qualifications',
              const <TradeFormStep>[TradeFormQualificationsStep()]),
        ]));

        expect(_questionKeys(out), <String>[key], reason: '$key was dropped');
      }
    });
  });
}
