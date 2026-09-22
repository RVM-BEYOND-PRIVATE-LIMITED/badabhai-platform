import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/cubit/jobs_cubit.dart';
import 'package:payer_app/features/jobs/presentation/edit_company_job_screen.dart';

/// The COMPANY edit screen used to patch only role title / location / vacancy
/// band and told the payer that "pay, experience and skills … are not editable
/// here yet" — while `GET /payer/job-postings` was already returning the city,
/// the ₹ band, the shift, the needed-by and the description on every row, and
/// `PATCH /payer/job-postings/:id` was already accepting all five. So the payer
/// could enter those details nowhere and correct them nowhere.
///
/// These pin the repair: the stored values are PREFILLED (never an invented
/// placeholder), only CHANGED fields ride the PATCH (a resent prefill could
/// clobber), an emptied box is not sent as a blank, and the two client-side
/// guards (pay ordering + the PII screen on the worker-visible description) fail
/// closed before the call.
class _ScriptedApi extends MockPayerApiClient {
  final List<String> updated = <String>[];
  String? lastRoleTitle;
  String? lastLocation;
  String? lastBand;
  String? lastCity;
  int? lastPayMin;
  int? lastPayMax;
  String? lastShift;
  String? lastNeededBy;
  String? lastDescription;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async =>
      const <JobPosting>[];

  @override
  Future<JobPosting> updateJob(
    String id, {
    String? orgLabel,
    String? roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    String? status,
    String? city,
    int? payMin,
    int? payMax,
    String? shift,
    String? area,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    List<String>? benefits,
    List<String>? requirements,
    String? neededBy,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
  }) async {
    updated.add(id);
    lastRoleTitle = roleTitle;
    lastLocation = locationLabel;
    lastBand = vacancyBand;
    lastCity = city;
    lastPayMin = payMin;
    lastPayMax = payMax;
    lastShift = shift;
    lastNeededBy = neededBy;
    lastDescription = description;
    return _job;
  }
}

/// A posting as the payer projection really returns it — the display fields
/// included (they are what the old form claimed it could not edit).
const JobPosting _job = JobPosting(
  id: 'j1',
  title: 'CNC Setter',
  band: '2-5',
  locationLabel: 'Pimpri, Pune',
  city: 'Pune',
  payMin: 22000,
  payMax: 28000,
  shift: 'day',
  description: 'Turning job work on Fanuc controls.',
  filled: 0,
  quota: 0,
  applicants: 0,
  unlocks: 0,
  status: JobStatus.live,
  verified: false,
  boosted: false,
  wireStatus: 'open',
);

void main() {
  late _ScriptedApi api;
  late JobsCubit cubit;

  /// Mount the screen on a tall viewport: the form is taller than the default
  /// 600px test surface, and a built field keeps every tap a real hit.
  Future<void> open(WidgetTester tester) async {
    api = _ScriptedApi();
    cubit = JobsCubit(api);
    addTearDown(cubit.close);

    tester.view.physicalSize = const Size(1000, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (BuildContext context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        EditCompanyJobScreen(job: _job, cubit: cubit),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  /// Type into the field that shows [label] (BbField renders the label as a
  /// sibling Text above its TextField).
  Future<void> typeInto(
    WidgetTester tester,
    String label,
    String value,
  ) async {
    final Finder field =
        find.ancestor(of: find.text(label), matching: find.byType(Column));
    await tester.enterText(
      find.descendant(of: field.first, matching: find.byType(TextField)),
      value,
    );
    await tester.pump();
  }

  /// Tap Save and pump just far enough for the toast to appear — a full drain
  /// would outlive the ~2.4s auto-dismiss and find nothing.
  Future<void> tapSave(WidgetTester tester) async {
    await tester.tap(find.text('Save changes'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.text('Save changes'));
    await tester.pump(); // start _save
    await tester.pump(const Duration(seconds: 1)); // PATCH + toast + pop
    // Drain the ~2.4s toast auto-dismiss timer so it does not outlive the test.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  }

  testWidgets('prefills the stored display fields, and drops the stale copy', (
    WidgetTester tester,
  ) async {
    await open(tester);

    expect(find.widgetWithText(TextField, 'Pune'), findsOneWidget); // city
    expect(find.widgetWithText(TextField, '22000'), findsOneWidget);
    expect(find.widgetWithText(TextField, '28000'), findsOneWidget);
    expect(
      find.widgetWithText(TextField, 'Turning job work on Fanuc controls.'),
      findsOneWidget,
    );

    // The old lie.
    expect(find.textContaining('not editable here yet'), findsNothing);

    // A stored shift is never offered a "Not set" it could not honour; the
    // unset needed-by is.
    expect(find.text('Day'), findsOneWidget);
    expect(find.text('Not set'), findsOneWidget);
  });

  testWidgets('only the CHANGED fields ride the PATCH', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(tester, 'City', 'Nashik');
    await typeInto(tester, 'Pay max ₹/mo', '30000');
    await typeInto(
      tester,
      'Description (optional)',
      'Night-shift turning on Fanuc controls.',
    );
    await tester.tap(find.text('Rotational'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Immediately'));
    await tester.pumpAndSettle();

    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastCity, 'Nashik');
    expect(api.lastPayMax, 30000);
    expect(api.lastShift, 'rotational');
    expect(api.lastNeededBy, 'immediate');
    expect(api.lastDescription, 'Night-shift turning on Fanuc controls.');
    // Untouched → omitted, so a stale prefill can never clobber the row.
    expect(api.lastPayMin, isNull);
    expect(api.lastRoleTitle, isNull);
    expect(api.lastLocation, isNull);
    expect(api.lastBand, isNull);
  });

  testWidgets('an emptied box is not sent (this contract cannot clear)', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(tester, 'City', '');
    await typeInto(tester, 'Description (optional)', '');
    // One real change so there IS something to save.
    await typeInto(tester, 'Job title', 'CNC Setter — Night');

    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastRoleTitle, 'CNC Setter — Night');
    expect(api.lastCity, isNull);
    expect(api.lastDescription, isNull);
  });

  testWidgets('an unchanged form says so instead of 400ing', (
    WidgetTester tester,
  ) async {
    await open(tester);
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Nothing to save'), findsOneWidget);
  });

  testWidgets('pay band ordering is refused before the call', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(tester, 'Pay min ₹/mo', '40000');
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Max pay must be at least the min.'), findsOneWidget);
  });

  testWidgets('a phone-shaped description is refused before the call', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(
      tester,
      'Description (optional)',
      'Call 98765 43210 to apply',
    );
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Check the description'), findsOneWidget);
  });
}
