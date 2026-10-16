import 'dart:convert';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/selection_cards.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_preferences_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// ── P7: availability status + notice period in the Availability walk ──────
///
/// The Availability, Terms & Salary résumé-section walk now asks when the
/// worker can join and their notice period (days), on two pages of their own,
/// so that section can be CORRECTED after the résumé is built. Onboarding is
/// unchanged. The save is the existing `PUT /workers/me/work-preferences`, and
/// because that PUT replaces the stored `availability` json whole, every save
/// re-sends all three parts.

const String _kNoticeError = 'Notice period 0 se 180 din ke beech likhein.';

const WorkPrefOptionsDto _options = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day shift'},
  availabilityStatus: <String, String>{
    'immediate': 'Immediately',
    'within_week': 'Within a week',
    'within_month': 'Within a month',
    'serving_notice': 'Serving notice',
  },
);

/// A worker whose availability, shift, cities and salary are all stored.
const TradeFormPreferences _stored = TradeFormPreferences(
  shift: 'day',
  preferredCities: <String>['Pune'],
  salaryExpectedMax: 20000,
  availabilityStatus: 'serving_notice',
  availableFrom: '2026-11-01',
  noticePeriodDays: 15,
);

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

/// A minimal stand-in for the server's preferences store: GET returns the
/// stored `values`; PUT applies only the keys the body carries — an absent key
/// is left alone, `null` deletes the row, and `availability` REPLACES the json
/// object whole (`worker-preferences.service.ts`).
class _FakePreferencesServer {
  _FakePreferencesServer(this.values);

  final Map<String, dynamic> values;
  final List<Map<String, dynamic>> puts = <Map<String, dynamic>>[];

  http.Client get client => MockClient((http.Request req) async {
        expect(req.url.path, '/workers/me/work-preferences');
        if (req.method == 'PUT') {
          final Map<String, dynamic> body =
              jsonDecode(req.body) as Map<String, dynamic>;
          puts.add(body);
          body.forEach((String key, dynamic value) {
            if (key == 'touched_only') return;
            if (value == null) {
              values.remove(key);
            } else {
              values[key] = value;
            }
          });
          return http.Response('{}', 200);
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'values': values,
            'partial': <String>[],
            'dropped_count': 0,
          }),
          200,
        );
      });
}

void main() {
  group('round trip through the existing preferences GET', () {
    test('enter 30 → save → reopen → 30; nothing else is wiped', () async {
      final _FakePreferencesServer server =
          _FakePreferencesServer(<String, dynamic>{
        'shift': 'day',
        'job_type': 'permanent',
        'preferred_cities': <String>['Pune'],
        'willing_to_relocate': true,
        'accommodation_needed': false,
        'salary_expected_max': 20000,
        'availability': <String, dynamic>{
          'status': 'serving_notice',
          'available_from': '2026-11-01',
          'notice_period_days': 15,
        },
      });
      final TradeFormRepositoryImpl repo = TradeFormRepositoryImpl(
        ApiClient(baseUrl: 'http://test', client: server.client),
        _session(),
      );

      final TradeFormPreferences opened = (await repo.loadSavedPreferences())!;
      expect(opened.noticePeriodDays, 15);
      expect(opened.availabilityStatus, 'serving_notice');
      expect(opened.availableFrom, '2026-11-01');

      await repo.savePreferences(opened.copyWith(noticePeriodDays: 30));

      expect(server.puts.single, <String, dynamic>{
        'touched_only': true,
        'shift': 'day',
        'job_type': 'permanent',
        'salary_expected_max': 20000,
        'availability': <String, dynamic>{
          'status': 'serving_notice',
          'available_from': '2026-11-01',
          'notice_period_days': 30,
        },
      }, reason: 'the stored status + date ride with the edit; lists and '
          'yes/no keys the worker did not touch are not sent');

      final TradeFormPreferences reopened =
          (await repo.loadSavedPreferences())!;
      expect(reopened.noticePeriodDays, 30);
      expect(reopened.availabilityStatus, 'serving_notice');
      expect(reopened.availableFrom, '2026-11-01');
      expect(reopened.shift, 'day');
      expect(reopened.jobType, 'permanent');
      expect(reopened.preferredCities, <String>['Pune']);
      expect(reopened.willingToRelocate, isTrue);
      expect(reopened.salaryExpectedMax, 20000);
    });

    test('a stored row whose only value is withheld still opens as stored',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'values': <String, dynamic>{'availability': null},
                'partial': <String>['availability'],
                'dropped_count': 1,
              }),
              200,
            )),
      );
      final TradeFormPreferences? opened =
          await TradeFormRepositoryImpl(api, _session()).loadSavedPreferences();

      expect(opened, isNotNull,
          reason: 'withheld is stored — never the "no row" null');
      expect(opened!.availabilityWithheld, isTrue);
      expect(opened.noticePeriodDays, isNull);
    });
  });

  group('the preferences page', () {
    late GlobalKey<TradeFormPreferencesPageState> key;
    TradeFormPreferences? saved;

    Future<void> pump(WidgetTester tester, {String? sectionKey}) async {
      key = GlobalKey<TradeFormPreferencesPageState>();
      saved = null;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TradeFormPreferencesPage(
              key: key,
              loadOptions: () async => _options,
              enabled: true,
              onSave: (TradeFormPreferences p) => saved = p,
              initialPreferences: _stored,
              sectionKey: sectionKey,
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();
    }

    Future<void> next(WidgetTester tester, int times) async {
      for (int i = 0; i < times; i++) {
        key.currentState!.goToNextPage();
        await tester.pumpAndSettle();
      }
    }

    bool selected(WidgetTester tester, String title) => tester
        .widget<SingleSelectQuestionCard>(
            find.widgetWithText(SingleSelectQuestionCard, title))
        .isSelected;

    testWidgets('onboarding never asks availability — unchanged', (
      WidgetTester tester,
    ) async {
      await pump(tester);

      expect(key.currentState!.pageCount, 6,
          reason: 'languages, documents, shift, job type, cities, terms');
      for (int i = 0; i < key.currentState!.pageCount; i++) {
        expect(find.text('Kab se available hain?'), findsNothing);
        expect(find.byKey(kTradeFormNoticeFieldKey), findsNothing);
        if (!key.currentState!.isLastPage) await next(tester, 1);
      }
    });

    testWidgets('the Availability walk asks status, then notice, before terms',
        (WidgetTester tester) async {
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      expect(key.currentState!.pageCount, 6,
          reason: 'shift, job type, cities, availability, notice, terms');
      await next(tester, 3);
      expect(find.text('Kab se available hain?'), findsOneWidget);
      await next(tester, 1);
      expect(find.text('Notice period kitne din ka hai?'), findsOneWidget);
      expect(find.text('Notice period (din)'), findsOneWidget);
      await next(tester, 1);
      expect(key.currentState!.isLastPage, isTrue, reason: 'terms saves last');
    });

    testWidgets('both pages open seeded from the stored answer', (
      WidgetTester tester,
    ) async {
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      await next(tester, 3);
      expect(selected(tester, 'Serving notice'), isTrue);
      expect(selected(tester, 'Immediately'), isFalse);
      await next(tester, 1);
      expect(
        tester
            .widget<TextField>(find.descendant(
                of: find.byKey(kTradeFormNoticeFieldKey),
                matching: find.byType(TextField)))
            .controller!
            .text,
        '15',
      );
    });

    testWidgets('a new notice saves the whole object, nothing else touched', (
      WidgetTester tester,
    ) async {
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      await next(tester, 4);
      await tester.enterText(find.byKey(kTradeFormNoticeFieldKey), '30');
      await tester.pump();
      await next(tester, 1);
      key.currentState!.save();

      expect(saved!.toJson(), <String, dynamic>{
        'touched_only': true,
        // Scalars carried by the prefill are re-sent as stored (their
        // existing rule); no list or yes/no key was touched.
        'shift': 'day',
        'salary_expected_max': 20000,
        'availability': <String, dynamic>{
          'status': 'serving_notice',
          'available_from': '2026-11-01',
          'notice_period_days': 30,
        },
      });
    });

    testWidgets('a status tap is saved with the stored notice and date', (
      WidgetTester tester,
    ) async {
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      await next(tester, 3);
      await tester.tap(find.text('Within a month'));
      await tester.pump();
      expect(selected(tester, 'Within a month'), isTrue);
      expect(selected(tester, 'Serving notice'), isFalse);
      await next(tester, 2);
      key.currentState!.save();

      expect(saved!.toJson()['availability'], <String, dynamic>{
        'status': 'within_month',
        'available_from': '2026-11-01',
        'notice_period_days': 15,
      });
    });

    testWidgets(
        'above 180, typed key by key, holds the page AND refuses the save',
        (WidgetTester tester) async {
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      await next(tester, 4);
      // One keystroke at a time, like a worker: 2 and 20 are valid on the way.
      for (final String typed in <String>['2', '20', '200']) {
        await tester.enterText(find.byKey(kTradeFormNoticeFieldKey), typed);
        await tester.pump();
      }

      expect(find.text(_kNoticeError), findsOneWidget, reason: 'inline');
      expect(key.currentState!.currentPageError(), _kNoticeError,
          reason: 'the screen\'s gate refuses "Aage badhein" on this');

      // Even if something moved the walk on to the saving page, the gate the
      // screen checks before the save still refuses it — the prefix 20 the
      // keystrokes left behind can never be saved for a box showing 200.
      await next(tester, 1);
      expect(key.currentState!.isLastPage, isTrue);
      expect(key.currentState!.currentPageError(), _kNoticeError);

      // Fixing the box releases both.
      key.currentState!.goToPreviousPage();
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(kTradeFormNoticeFieldKey), '90');
      await tester.pump();
      expect(key.currentState!.currentPageError(), isNull);
      await next(tester, 1);
      expect(key.currentState!.currentPageError(), isNull);
      key.currentState!.save();
      expect(saved!.noticePeriodDays, 90);
    });

    testWidgets('both new pages fit 320x568 at 2.0 text scale', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1.0;
      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      await next(tester, 2); // shift → job type → cities
      // The cities page's own heading row overflows at this scale. That is
      // PRE-EXISTING (design2_cities_page.dart, unchanged here) and tracked
      // separately — it is not this test's subject, so its error is cleared.
      tester.takeException();

      await next(tester, 1);
      expect(find.text('Kab se available hain?'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await next(tester, 1);
      expect(find.byKey(kTradeFormNoticeFieldKey), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.enterText(find.byKey(kTradeFormNoticeFieldKey), '200');
      await tester.pump();
      expect(find.text(_kNoticeError), findsOneWidget);
      expect(tester.takeException(), isNull,
          reason: 'the inline range error must fit too');
    });

    testWidgets('180 is accepted; only digits reach the box', (
      WidgetTester tester,
    ) async {
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      await next(tester, 4);
      await tester.enterText(find.byKey(kTradeFormNoticeFieldKey), '1-8.0');
      await tester.pump();

      expect(
        tester
            .widget<TextField>(find.descendant(
                of: find.byKey(kTradeFormNoticeFieldKey),
                matching: find.byType(TextField)))
            .controller!
            .text,
        '180',
      );
      expect(key.currentState!.currentPageError(), isNull);
      await next(tester, 1);
      key.currentState!.save();
      expect(saved!.noticePeriodDays, 180);
    });

    testWidgets('an emptied box clears the notice and keeps the status', (
      WidgetTester tester,
    ) async {
      await pump(tester, sectionKey: kResumeMenuAvailabilitySalaryKey);

      await next(tester, 4);
      await tester.enterText(find.byKey(kTradeFormNoticeFieldKey), '');
      await tester.pump();
      expect(key.currentState!.currentPageError(), isNull);
      await next(tester, 1);
      key.currentState!.save();

      expect(saved!.toJson()['availability'], <String, dynamic>{
        'status': 'serving_notice',
        'available_from': '2026-11-01',
        'notice_period_days': null,
      });
    });
  });
}
