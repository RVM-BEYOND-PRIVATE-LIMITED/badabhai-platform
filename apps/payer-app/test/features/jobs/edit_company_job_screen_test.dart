import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:get_it/get_it.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/widgets/bb_action_bar.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_shake.dart';
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
  String? lastRoleKind;
  String? lastTradeLevel;
  Map<String, List<String>>? lastTradeAnswers;

  /// Every clearable field the last PATCH carried a VALUE for — so a test can
  /// assert no field ever rode both the body and `clear` (a server 400).
  Set<JobPostingClearField> lastValued = <JobPostingClearField>{};

  /// When set, every [updateJob] throws it after recording the call — the
  /// server refusing the save.
  Object? throwOnUpdate;

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
    String? roleKind,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
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
    lastRoleKind = roleKind;
    lastTradeLevel = tradeLevel;
    lastTradeAnswers = tradeAnswers;
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
    }
        .entries
        .where((MapEntry<JobPostingClearField, Object?> e) => e.value != null)
        .map((MapEntry<JobPostingClearField, Object?> e) => e.key)
        .toSet();
    if (throwOnUpdate != null) throw throwOnUpdate!;
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

/// [_job] with the migration-0139 trade form already stored — the panel must be
/// visible and its edits must ride the PATCH.
const JobPosting _jobTrade = JobPosting(
  id: 'j1',
  title: 'CNC Setter',
  band: '2-5',
  locationLabel: 'Pimpri, Pune',
  city: 'Pune',
  area: 'Chakan',
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
  roleKind: 'cnc_turner',
  tradeLevel: 'setter',
  tradeAnswers: <String, List<String>>{
    'controller_brand': <String>['fanuc'],
  },
);

void main() {
  late _ScriptedApi api;
  late JobsCubit cubit;

  /// Mount the screen on a tall viewport: the form is taller than the default
  /// 600px test surface, and a built field keeps every tap a real hit.
  Future<void> open(
    WidgetTester tester, {
    JobPosting job = _job,
    double height = 4000,
  }) async {
    api = _ScriptedApi();
    cubit = JobsCubit(api);
    addTearDown(cubit.close);

    // The trade catalogue is read through the locator (migration 0141), so the
    // graph must be wired for the role/trade panel to render.
    await GetIt.instance.reset();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());

    tester.view.physicalSize = Size(1000, height);
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
    // #2595 — the ₹ band prefills Indian-grouped, as the pay boxes show it.
    expect(find.widgetWithText(TextField, '22,000'), findsOneWidget);
    expect(find.widgetWithText(TextField, '28,000'), findsOneWidget);
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
    // #2595 — the reason sits at the description, not in a toast.
    expect(
      find.text(
        'Leave phone numbers and email addresses out of the description.',
      ),
      findsOneWidget,
    );
  });

  // Migration 0141 — the role + trade form must be visible on the edit screen
  // too, and a rung change must ride the PATCH (it is display-only, never a
  // match input, but it is still stored).
  testWidgets('a stored trade form is prefilled, and a rung edit rides PATCH', (
    WidgetTester tester,
  ) async {
    await open(tester, job: _jobTrade, height: 5000);

    // The catalogue loaded from the mock; the stored role is selected and the
    // panel is visible because the posting already uses the trade form.
    expect(find.text('Role'), findsOneWidget);
    expect(find.text('CNC Turner'), findsOneWidget);
    expect(find.text('Trade requirements'), findsOneWidget);
    expect(find.text('Rung'), findsOneWidget);
    expect(find.text('Setter'), findsOneWidget);

    await tester.tap(find.text('Programmer'));
    await tester.pumpAndSettle();
    await save(tester);

    expect(api.updated, <String>['j1']);
    expect(api.lastRoleKind, 'cnc_turner');
    expect(api.lastTradeLevel, 'programmer');
    expect(api.lastTradeAnswers, <String, List<String>>{
      'controller_brand': <String>['fanuc'],
    });
  });

  // --- #2595 (M7) -------------------------------------------------------------

  testWidgets('Save is pinned in the shared action bar, like Post', (
    WidgetTester tester,
  ) async {
    await open(tester);
    final Scaffold scaffold = tester.widget<Scaffold>(find.descendant(
      of: find.byType(EditCompanyJobScreen),
      matching: find.byType(Scaffold),
    ));
    expect(scaffold.bottomNavigationBar, isA<BbActionBar>());
    expect(
      find.descendant(
        of: find.byType(BbActionBar),
        matching: find.text('Save changes'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a refused save shows every reason at its field — no toast', (
    WidgetTester tester,
  ) async {
    await open(tester);
    await typeInto(tester, 'Job title', '');
    await typeInto(tester, 'City', '');
    await typeInto(tester, 'Exp max (yrs)', '');
    await tapSave(tester);

    expect(api.updated, isEmpty);
    expect(find.text('Add the job title'), findsOneWidget);
    expect(find.text('Add the city'), findsOneWidget);
    expect(find.text('Add the experience'), findsOneWidget);
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets("the server's refusal shows at the box it names — no toast", (
    WidgetTester tester,
  ) async {
    await open(tester);
    // The server screens the worker-visible Area for a company name.
    api.throwOnUpdate = const PayerApiException(
      400,
      validationMessage: 'Area: Must not contain a company name.',
      fieldErrors: <String, String>{
        'area': 'Must not contain a company name.',
      },
    );
    await typeInto(tester, 'Area (optional)', 'Tata Motors Pvt Ltd');
    await tapSave(tester);
    await tester.pumpAndSettle();

    expect(api.updated, hasLength(1));
    expect(
      find.descendant(
        of: find.ancestor(
          of: find.text('Area (optional)'),
          matching: find.byType(BbShake),
        ),
        matching: find.text('Must not contain a company name.'),
      ),
      findsOneWidget,
    );
    expect(find.byType(SnackBar), findsNothing);
    // Still on the form, and Save is live again.
    expect(find.text('Edit job'), findsOneWidget);
    expect(
      tester
          .widget<BbButton>(find.widgetWithText(BbButton, 'Save changes'))
          .loading,
      isFalse,
    );

    // Changing the area is what clears it.
    await typeInto(tester, 'Area (optional)', 'Chakan MIDC');
    await tester.pumpAndSettle();
    expect(find.text('Must not contain a company name.'), findsNothing);
  });

  testWidgets('Back on an unedited job leaves at once', (
    WidgetTester tester,
  ) async {
    await open(tester);
    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    expect(find.text('Edit job'), findsNothing);
    expect(find.text('Discard your changes?'), findsNothing);
  });

  testWidgets(
      'Back (arrow or system) on an edited job asks before discarding it', (
    WidgetTester tester,
  ) async {
    await open(tester);
    await typeInto(tester, 'City', 'Nashik');

    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    expect(find.text('Discard your changes?'), findsOneWidget);
    await tester.tap(find.text('Keep editing'));
    await tester.pumpAndSettle();
    expect(find.text('Edit job'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Nashik'), findsOneWidget);

    // The Android system Back takes the same path.
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Discard your changes?'), findsOneWidget);
    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    expect(find.text('Edit job'), findsNothing);
    expect(api.updated, isEmpty);
  });

  testWidgets('an edit put back to the saved value is no change', (
    WidgetTester tester,
  ) async {
    await open(tester);
    await typeInto(tester, 'City', 'Nashik');
    await typeInto(tester, 'City', 'Pune');
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Discard your changes?'), findsNothing);
    expect(find.text('Edit job'), findsNothing);
  });

  testWidgets('the keyboard "next" walks the text boxes; "done" ends it', (
    WidgetTester tester,
  ) async {
    await open(tester);
    Finder box(String label) => find.descendant(
          of: find
              .ancestor(of: find.text(label), matching: find.byType(Column))
              .first,
          matching: find.byType(TextField),
        );
    bool focused(String label) => tester
        .widget<EditableText>(
          find.descendant(of: box(label), matching: find.byType(EditableText)),
        )
        .focusNode
        .hasFocus;
    const List<String> chain = <String>[
      'Job title',
      'Location',
      'City',
      'Area (optional)',
      'Pay min ₹/mo',
      'Pay max ₹/mo',
      'Exp min (yrs)',
      'Exp max (yrs)',
    ];
    await tester.tap(box(chain.first));
    await tester.pump();
    for (int i = 1; i < chain.length; i++) {
      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pump();
      expect(focused(chain[i]), isTrue, reason: chain[i]);
    }
    expect(
      tester.widget<TextField>(box('Exp max (yrs)')).textInputAction,
      TextInputAction.done,
    );
  });
}
