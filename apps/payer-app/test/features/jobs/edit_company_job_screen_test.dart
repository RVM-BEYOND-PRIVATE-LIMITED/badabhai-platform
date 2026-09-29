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
/// clobber), an emptied box is never sent as a blank — an emptied OPTIONAL box
/// that had a value rides `clear` instead (#1652) — and the two client-side
/// guards (pay ordering + the PII screen on the worker-visible description) fail
/// closed before the call.
class _ScriptedApi extends MockPayerApiClient {
  final List<String> updated = <String>[];
  String? lastRoleTitle;
  String? lastLocation;
  String? lastBand;
  String? lastCity;
  String? lastArea;
  int? lastPayMin;
  int? lastPayMax;
  String? lastShift;
  String? lastNeededBy;
  String? lastDescription;
  List<JobPostingClearField>? lastClear;

  /// Every clearable field the last PATCH carried a VALUE for — so a test can
  /// assert no field ever rode both the body and `clear` (a server 400).
  Set<JobPostingClearField> lastValued = <JobPostingClearField>{};

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
    List<JobPostingClearField>? clear,
  }) async {
    updated.add(id);
    lastRoleTitle = roleTitle;
    lastLocation = locationLabel;
    lastBand = vacancyBand;
    lastCity = city;
    lastArea = area;
    lastPayMin = payMin;
    lastPayMax = payMax;
    lastShift = shift;
    lastNeededBy = neededBy;
    lastDescription = description;
    lastClear = clear;
    lastValued = <JobPostingClearField, Object?>{
      JobPostingClearField.locationLabel: locationLabel,
      JobPostingClearField.description: description,
      JobPostingClearField.city: city,
      JobPostingClearField.area: area,
      JobPostingClearField.payMin: payMin,
      JobPostingClearField.payMax: payMax,
      JobPostingClearField.payType: payType,
      JobPostingClearField.minExperienceYears: minExperienceYears,
      JobPostingClearField.maxExperienceYears: maxExperienceYears,
      JobPostingClearField.shift: shift,
      JobPostingClearField.neededBy: neededBy,
      JobPostingClearField.benefits: benefits,
      JobPostingClearField.requirements: requirements,
    }.entries
        .where((MapEntry<JobPostingClearField, Object?> e) => e.value != null)
        .map((MapEntry<JobPostingClearField, Object?> e) => e.key)
        .toSet();
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
  // The optional half of the place line — present so emptying it is a real
  // removal (#1652), not a no-op on a box that was never set.
  area: 'Chakan',
  payMin: 22000,
  payMax: 28000,
  // The rest of what the worker's card renders. The form REFUSES a save that
  // would leave any of them blank, so a fixture missing one is a row that could
  // not legally be saved in the first place.
  payType: 'in_hand',
  minExperienceYears: 1,
  maxExperienceYears: 4,
  neededBy: 'soon',
  benefits: <String>['PF + ESI'],
  requirements: <String>['Fanuc control'],
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

/// The same card-complete row, but with neither optional box ever stored.
const JobPosting _jobNoOptional = JobPosting(
  id: 'j1',
  title: 'CNC Setter',
  band: '2-5',
  city: 'Pune',
  payMin: 22000,
  payMax: 28000,
  payType: 'in_hand',
  minExperienceYears: 1,
  maxExperienceYears: 4,
  neededBy: 'soon',
  benefits: <String>['PF + ESI'],
  requirements: <String>['Fanuc control'],
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
  Future<void> open(WidgetTester tester, {JobPosting job = _job}) async {
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
                        EditCompanyJobScreen(job: job, cubit: cubit),
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

    // The stored enums are selected, and there is NO "leave it unstated" chip
    // to select instead: every one of these is printed on the worker's card.
    expect(find.text('Day'), findsOneWidget);
    expect(find.text('Within weeks'), findsOneWidget);
    expect(find.text('In-hand'), findsOneWidget);
    expect(find.text('Not set'), findsNothing);
    expect(find.text('Not stated'), findsNothing);
  });

  testWidgets('only the CHANGED fields ride the PATCH', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(tester, 'City', 'Nashik');
    await typeInto(tester, 'Pay max ₹/mo', '30000');
    await typeInto(
      tester,
      'Description',
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

  testWidgets('an emptied Location rides clear, never as a blank value', (
    WidgetTester tester,
  ) async {
    await open(tester);

    // Location is the payer's own note — not a card field — so emptying it is
    // allowed. Since #1652 that REMOVES the saved note via `clear`; it must
    // still never ride as a blank the route would 400.
    await typeInto(tester, 'Location', '');
    await typeInto(tester, 'Job title', 'CNC Setter — Night');

    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastRoleTitle, 'CNC Setter — Night');
    expect(api.lastLocation, isNull);
    expect(api.lastClear, <JobPostingClearField>[
      JobPostingClearField.locationLabel,
    ]);
  });

  testWidgets('emptying a saved Area alone is a save — it rides clear', (
    WidgetTester tester,
  ) async {
    await open(tester);

    // The ONLY change: without `clear` this would be "Nothing to save".
    await typeInto(tester, 'Area (optional)', '');
    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastArea, isNull);
    expect(api.lastClear, <JobPostingClearField>[JobPostingClearField.area]);
    expect(find.text('Nothing to save'), findsNothing);
  });

  testWidgets('no clear when the optional boxes are left as they were', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(tester, 'Job title', 'CNC Setter — Night');
    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastClear, isNull);
  });

  testWidgets('no clear for an optional box that was never set', (
    WidgetTester tester,
  ) async {
    // Neither Location nor Area was ever stored: an empty box is no change.
    await open(tester, job: _jobNoOptional);

    await typeInto(tester, 'Job title', 'CNC Setter — Night');
    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastClear, isNull);
    expect(api.lastLocation, isNull);
    expect(api.lastArea, isNull);
  });

  testWidgets('a field is never in both the body and clear', (
    WidgetTester tester,
  ) async {
    await open(tester);

    // Empty one optional box, REWRITE the other, and change card fields too.
    await typeInto(tester, 'Area (optional)', '   ');
    await typeInto(tester, 'Location', 'Bhosari MIDC');
    await typeInto(tester, 'City', 'Nashik');
    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastClear, <JobPostingClearField>[JobPostingClearField.area]);
    expect(api.lastLocation, 'Bhosari MIDC');
    expect(api.lastCity, 'Nashik');
    expect(
      api.lastValued.intersection(api.lastClear!.toSet()),
      isEmpty,
      reason: 'a field both set and cleared is a server 400',
    );
  });

  testWidgets('the stale "cannot remove" copy is gone', (
    WidgetTester tester,
  ) async {
    await open(tester);

    expect(find.textContaining('not remove them'), findsNothing);
    expect(
      find.textContaining('Emptying Area or Location removes it'),
      findsOneWidget,
    );
  });

  testWidgets('emptying the city is REFUSED — the card needs a place', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(tester, 'City', '');
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Add the city'), findsOneWidget);
  });

  testWidgets('emptying the description is REFUSED', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await typeInto(tester, 'Description', '');
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Add the description'), findsOneWidget);
  });

  testWidgets('clearing the last requirement chip is REFUSED', (
    WidgetTester tester,
  ) async {
    await open(tester);

    // Tapping a chip removes it — the stored row has exactly one.
    await tester.tap(find.text('Fanuc control'));
    await tester.pumpAndSettle();
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Add a requirement'), findsOneWidget);
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
      'Description',
      'Call 98765 43210 to apply',
    );
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Check the description'), findsOneWidget);
  });
}
