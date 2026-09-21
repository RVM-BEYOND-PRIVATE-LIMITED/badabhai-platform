import 'dart:convert';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'trade_form_universal_fixture.dart';

class _MockRepo extends Mock implements TradeFormRepository {}

/// The question screen's decline link.
const String _kDecline = 'Pata nahi / Baad mein batayein';

const WorkPrefOptionsDto _prefOptions = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
  cities: <CityOptionDto>[
    CityOptionDto(value: 'Faridabad', aliases: <String>[], state: 'Haryana'),
  ],
  states: <String>['Haryana'],
);

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const TradeFormAnswer.declined());
    registerFallbackValue(const TradeFormPreferences());
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(() => repo.loadPreferenceOptions())
        .thenAnswer((_) async => _prefOptions);
    locator.registerFactory<TradeFormCubit>(() => TradeFormCubit(repo));
  });

  tearDown(() => locator.reset());

  /// Parses the real wire payload through the real repository, so the guard
  /// under test is the one the app runs. [known] is what /name and the chat
  /// recorded before the form opened.
  Future<void> stubDeployedForm(
    WidgetTester tester, {
    Set<WorkerFact> known = const <WorkerFact>{},
  }) async {
    final TradeFormRepositoryImpl parser = TradeFormRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(universalAppendedFormJson()), 200)),
      ),
      SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok'),
      knownFacts: InMemoryKnownWorkerFactsStore(known),
    );
    final TradeForm form =
        (await tester.runAsync<TradeForm?>(parser.loadForm))!;
    when(() => repo.loadForm()).thenAnswer((_) async => form);
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'x',
          status: TradeFormAnswerStatus.declined,
          answered: 1,
          total: 3,
        ));
  }

  Widget app({double textScale = 1.0}) => MaterialApp.router(
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        routerConfig: GoRouter(
          initialLocation: '/trade-form',
          routes: <RouteBase>[
            GoRoute(
              path: '/trade-form',
              builder: (_, __) => const TradeFormScreen(),
            ),
          ],
        ),
      );

  testWidgets(
      'on the deployed form a worker whose city /name saved never sees a city '
      'question before the preferences page', (WidgetTester tester) async {
    await stubDeployedForm(tester, known: <WorkerFact>{WorkerFact.currentCity});

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    bool sawAvailability = false;
    // Walk every question screen up to the first marker page.
    for (int guard = 0;
        guard < 12 && find.text(_kDecline).evaluate().isNotEmpty;
        guard++) {
      expect(find.text(kUniversalPreferredCityPrompt), findsNothing);
      expect(find.text(kUniversalCurrentCityPrompt), findsNothing);
      if (find.text(kUniversalAvailabilityPrompt).evaluate().isNotEmpty) {
        sawAvailability = true;
      }
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
    }

    // On the preferences page now (its first internal page lists languages).
    expect(find.text('Hindi'), findsOneWidget);
    expect(sawAvailability, isTrue);
    final List<dynamic> asked = verify(() => repo.submitAnswer(
          questionKey: captureAny(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).captured;
    expect(asked,
        <String>['turning_experience', 'turning_machine', 'availability']);
  });

  testWidgets(
      'a worker who skipped the city on /name is asked it ONCE, with the '
      'State → City pickers and no text box, without overflow at 320x568 2.0x',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await stubDeployedForm(tester);

    await tester.pumpWidget(app(textScale: 2.0));
    await tester.pumpAndSettle();

    for (int guard = 0;
        guard < 4 && find.text(kUniversalCurrentCityPrompt).evaluate().isEmpty;
        guard++) {
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
    }

    expect(find.text(kUniversalCurrentCityPrompt), findsOneWidget);
    expect(find.byType(TextField), findsNothing,
        reason: 'the city is picked, never typed into a plain box');
    expect(find.text('STATE CHUNEIN'), findsOneWidget);
    expect(find.text('SHEHER CHUNEIN'), findsOneWidget);
    expect(tester.takeException(), isNull);
    final List<dynamic> asked = verify(() => repo.submitAnswer(
          questionKey: captureAny(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).captured;
    expect(asked, <String>['turning_experience', 'turning_machine']);
  });
}
