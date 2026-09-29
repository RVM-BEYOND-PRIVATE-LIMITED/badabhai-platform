import 'dart:convert';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

/// #1516 — `GET /workers/me/employment` now carries `employment_suggestions`:
/// jobs from a résumé or the chat interview the worker never confirmed. These
/// tests pin the wire parse, the repository's mapping, the "same job?" rule
/// the page uses to hide one, and the cubit carrying the list to the page.
class _MockRepo extends Mock implements TradeFormRepository {}

Map<String, dynamic> _suggestion(
  String source, {
  String? employer,
  String? city,
  String? role,
  String? start,
  String? end,
  String? work,
}) =>
    <String, dynamic>{
      'source': source,
      'values': <String, dynamic>{
        'employer_name': employer,
        'employer_city': city,
        'role_label': role,
        'start_ym': start,
        'end_ym': end,
        'work_done': work,
      },
    };

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

TradeFormRepositoryImpl _repoAnswering(Map<String, dynamic> body) {
  final ApiClient api = ApiClient(
    baseUrl: 'http://test',
    client: MockClient((http.Request req) async {
      expect(req.method, 'GET');
      expect(req.url.path, '/workers/me/employment');
      return http.Response(jsonEncode(body), 200);
    }),
  );
  return TradeFormRepositoryImpl(api, _session());
}

void main() {
  group('MyEmploymentDto.employmentSuggestions — the wire parse', () {
    test('reads every value of both sources, in the server order', () {
      final MyEmploymentDto dto = MyEmploymentDto.fromJson(<String, dynamic>{
        'employments': <dynamic>[],
        'unreadable_count': 0,
        'employment_suggestions': <dynamic>[
          _suggestion('resume', employer: 'Sandhar', role: 'CNC Operator'),
          _suggestion(
            'chat',
            role: 'VMC Setter',
            start: '2019-03',
            end: '2022-02',
            work: 'Job setting karte the',
          ),
        ],
      });

      expect(dto.employmentSuggestions, const <EmploymentSuggestionDto>[
        EmploymentSuggestionDto(
          source: 'resume',
          employerName: 'Sandhar',
          roleLabel: 'CNC Operator',
        ),
        EmploymentSuggestionDto(
          source: 'chat',
          roleLabel: 'VMC Setter',
          startYm: '2019-03',
          endYm: '2022-02',
          workDone: 'Job setting karte the',
        ),
      ]);
    });

    test('an absent key (an older server) reads as no suggestions', () {
      final MyEmploymentDto dto = MyEmploymentDto.fromJson(
        <String, dynamic>{'employments': <dynamic>[], 'unreadable_count': 0},
      );
      expect(dto.employmentSuggestions, isEmpty);
    });

    test('a null key reads as no suggestions, never a crash', () {
      final MyEmploymentDto dto = MyEmploymentDto.fromJson(<String, dynamic>{
        'employments': <dynamic>[],
        'unreadable_count': 0,
        'employment_suggestions': null,
      });
      expect(dto.employmentSuggestions, isEmpty);
    });

    test('null values, a missing values map and wrong types read as null',
        () {
      final MyEmploymentDto dto = MyEmploymentDto.fromJson(<String, dynamic>{
        'employments': <dynamic>[],
        'unreadable_count': 0,
        'employment_suggestions': <dynamic>[
          _suggestion('chat'),
          <String, dynamic>{'source': 'resume'},
          <String, dynamic>{
            'source': 7,
            'values': <String, dynamic>{'role_label': 42, 'work_done': true},
          },
          'not-an-object',
        ],
      });

      expect(dto.employmentSuggestions, const <EmploymentSuggestionDto>[
        EmploymentSuggestionDto(source: 'chat'),
        EmploymentSuggestionDto(source: 'resume'),
        EmploymentSuggestionDto(source: ''),
      ]);
    });

    test('the stored rows and their count are read exactly as before', () {
      final MyEmploymentDto dto = MyEmploymentDto.fromJson(<String, dynamic>{
        'employments': <dynamic>[
          <String, dynamic>{
            'employment_id': 'e1',
            'employer_name': 'Acme',
            'roles': <dynamic>[
              <String, dynamic>{'role_label': 'Fitter'},
            ],
          },
        ],
        'unreadable_count': 1,
        'employment_suggestions': <dynamic>[
          _suggestion('chat', role: 'Fitter'),
        ],
      });

      expect(dto.employments.single.employerName, 'Acme');
      // A suggestion is not a row: it never counts toward the PUT's echo.
      expect(dto.expectedExistingCount, 2);
    });
  });

  group('TradeFormRepositoryImpl.loadSavedEmployment — suggestions', () {
    test('maps both sources, trimmed, in the server order', () async {
      final TradeFormStoredEmployment stored = await _repoAnswering(
        <String, dynamic>{
          'employments': <dynamic>[],
          'unreadable_count': 0,
          'employment_suggestions': <dynamic>[
            _suggestion('resume', employer: '  Sandhar  ', role: 'Operator '),
            _suggestion('chat', role: 'Welder', work: ' Joint banate the '),
          ],
        },
      ).loadSavedEmployment();

      expect(stored.suggestions, const <TradeFormEmploymentSuggestion>[
        TradeFormEmploymentSuggestion(
          source: TradeFormEmploymentSuggestionSource.resume,
          employerName: 'Sandhar',
          roleLabel: 'Operator',
        ),
        TradeFormEmploymentSuggestion(
          source: TradeFormEmploymentSuggestionSource.chat,
          roleLabel: 'Welder',
          workDone: 'Joint banate the',
        ),
      ]);
      // Never rows, never counted.
      expect(stored.entries, isEmpty);
      expect(stored.expectedExistingCount, 0);
    });

    test('drops a source it cannot name and a suggestion with nothing in it',
        () async {
      final TradeFormStoredEmployment stored = await _repoAnswering(
        <String, dynamic>{
          'employments': <dynamic>[],
          'unreadable_count': 0,
          'employment_suggestions': <dynamic>[
            _suggestion('voice', role: 'Fitter'),
            _suggestion('resume', employer: '   ', role: ''),
            _suggestion('chat', role: 'Fitter'),
          ],
        },
      ).loadSavedEmployment();

      expect(stored.suggestions, const <TradeFormEmploymentSuggestion>[
        TradeFormEmploymentSuggestion(
          source: TradeFormEmploymentSuggestionSource.chat,
          roleLabel: 'Fitter',
        ),
      ]);
    });

    test('an absent list leaves the stored history untouched', () async {
      final TradeFormStoredEmployment stored = await _repoAnswering(
        <String, dynamic>{'employments': <dynamic>[], 'unreadable_count': 0},
      ).loadSavedEmployment();

      expect(stored.suggestions, isEmpty);
      expect(stored.isEmpty, isTrue);
    });
  });

  group('TradeFormEmploymentSuggestion.matches — never the same job twice', () {
    const TradeFormEmploymentEntry saved = TradeFormEmploymentEntry(
      employerName: 'Sandhar Technologies',
      roleLabel: 'Cnc Operator',
    );

    test('a résumé suggestion matches on role AND company, ignoring case', () {
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.resume,
        employerName: 'sandhar  technologies',
        roleLabel: 'CNC OPERATOR',
      );
      expect(s.matches(saved), isTrue);
      expect(
        s.matches(saved.copyWith(employerName: 'Other Co')),
        isFalse,
      );
      expect(s.matches(saved.copyWith(roleLabel: 'Welder')), isFalse);
    });

    test('a chat suggestion (no company) matches on its role alone', () {
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.chat,
        roleLabel: 'cnc operator',
        workDone: 'Parts banate the',
      );
      expect(s.matches(saved), isTrue);
      expect(s.matches(saved.copyWith(roleLabel: 'Welder')), isFalse);
    });

    test('a company-only suggestion matches on the company', () {
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.resume,
        employerName: 'Sandhar Technologies',
      );
      expect(s.matches(saved), isTrue);
    });

    test('a suggestion stating neither role nor company matches nothing', () {
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.chat,
        workDone: 'Parts banate the',
      );
      expect(s.matches(saved), isFalse);
      expect(
        s.matches(const TradeFormEmploymentEntry(
          employerName: '',
          roleLabel: '',
        )),
        isFalse,
      );
    });

    test('the role is checked against every stored stint, not only the first',
        () {
      const TradeFormEmploymentEntry promoted = TradeFormEmploymentEntry(
        employerName: 'Acme',
        roleLabel: 'Helper',
        storedRoles: <Map<String, dynamic>>[
          <String, dynamic>{'role_label': 'Helper'},
          <String, dynamic>{'role_label': 'Supervisor'},
        ],
      );
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.chat,
        roleLabel: 'supervisor',
      );
      expect(s.matches(promoted), isTrue);
    });
  });

  group('TradeFormEmploymentSuggestion.toEntry — the prefilled new card', () {
    test('carries every stated fact and nothing else', () {
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.resume,
        employerName: 'Sandhar',
        employerCity: 'Pune',
        roleLabel: 'Operator',
        startYm: '2019-03',
        endYm: '2022-02',
        workDone: 'Parts banate the',
      );
      expect(
        s.toEntry(),
        const TradeFormEmploymentEntry(
          employerName: 'Sandhar',
          employerCity: 'Pune',
          roleLabel: 'Operator',
          startYm: '2019-03',
          endYm: '2022-02',
          workDone: 'Parts banate the',
          stillWorking: false,
        ),
      );
    });

    test('a chat suggestion leaves the company blank for the worker to type,'
        ' and never claims a current job', () {
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.chat,
        roleLabel: 'Welder',
      );
      final TradeFormEmploymentEntry e = s.toEntry();
      expect(e.employerName, '');
      expect(e.roleLabel, 'Welder');
      expect(e.startYm, isNull);
      expect(e.endYm, isNull);
      expect(e.stillWorking, isFalse);
      expect(e.isComplete, isFalse);
    });
  });

  test('TradeFormStoredEmployment.openSuggestions drops the ones already saved',
      () {
    const TradeFormEmploymentSuggestion savedOne =
        TradeFormEmploymentSuggestion(
      source: TradeFormEmploymentSuggestionSource.chat,
      roleLabel: 'Fitter',
    );
    const TradeFormEmploymentSuggestion newOne = TradeFormEmploymentSuggestion(
      source: TradeFormEmploymentSuggestionSource.resume,
      employerName: 'Sandhar',
      roleLabel: 'Operator',
    );
    const TradeFormStoredEmployment stored = TradeFormStoredEmployment(
      entries: <TradeFormEmploymentEntry>[
        TradeFormEmploymentEntry(employerName: 'Acme', roleLabel: 'fitter'),
      ],
      expectedExistingCount: 1,
      suggestions: <TradeFormEmploymentSuggestion>[savedOne, newOne],
    );

    expect(stored.openSuggestions, <TradeFormEmploymentSuggestion>[newOne]);
    expect(stored.suggestions, hasLength(2)); // the raw list is untouched
  });

  group('TradeFormCubit.load — the suggestions reach the page state', () {
    late _MockRepo repo;

    const TradeForm form = TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 'finish',
          title: 'Finish',
          screens: <TradeFormStep>[TradeFormEmploymentStep()],
        ),
      ],
    );

    setUp(() {
      repo = _MockRepo();
      when(() => repo.loadForm(upgradeView: any(named: 'upgradeView')))
          .thenAnswer((_) async => form);
    });

    test('from the same read as the stored rows', () async {
      const TradeFormEmploymentSuggestion s = TradeFormEmploymentSuggestion(
        source: TradeFormEmploymentSuggestionSource.chat,
        roleLabel: 'Welder',
      );
      when(() => repo.loadSavedEmployment()).thenAnswer(
        (_) async => const TradeFormStoredEmployment(
          suggestions: <TradeFormEmploymentSuggestion>[s],
        ),
      );
      final TradeFormCubit cubit = TradeFormCubit(repo);
      addTearDown(cubit.close);

      await cubit.load();

      expect(cubit.state.status, TradeFormStatus.ready);
      expect(
        cubit.state.employmentSuggestions,
        const <TradeFormEmploymentSuggestion>[s],
      );
      // Not a row: the page's prefill is still "nothing stored".
      expect(cubit.state.savedEmployment, isEmpty);
    });

    test('none offered is an empty list, never null', () async {
      when(() => repo.loadSavedEmployment())
          .thenAnswer((_) async => const TradeFormStoredEmployment());
      final TradeFormCubit cubit = TradeFormCubit(repo);
      addTearDown(cubit.close);

      await cubit.load();

      expect(cubit.state.employmentSuggestions, isEmpty);
    });
  });
}
