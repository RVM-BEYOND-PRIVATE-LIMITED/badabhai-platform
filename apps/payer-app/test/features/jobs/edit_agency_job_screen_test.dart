import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/cubit/agency_jobs_cubit.dart';
import 'package:payer_app/features/jobs/presentation/edit_agency_job_screen.dart';

/// The agency edit screen is prefilled from the [AgencyJobView] and a Save
/// drives the shared cubit's PATCH. These pin the things a form regresses on:
/// the prefill (an empty form would silently wipe fields), that Save actually
/// reaches `updateAgencyJob` with the edited value, and — for the four
/// WORKER-VISIBLE fields the job view cannot read back (description / shift /
/// benefits / requirements) — that an untouched input sends NOTHING while a
/// typed one is sent verbatim.
class _ScriptedApi extends MockPayerApiClient {
  final List<String> updated = <String>[];
  String? lastTitle;

  /// The worker-visible content of the last PATCH — the four fields the agency
  /// view cannot read back, so the form can only ever SEND them.
  String? lastDescription;
  String? lastShift;
  List<String>? lastBenefits;
  List<String>? lastRequirements;

  @override
  Future<AgencyJobView> updateAgencyJob(
    String id, {
    String? tradeKey,
    String? title,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
    String? description,
    String? shift,
    List<String>? benefits,
    List<String>? requirements,
  }) async {
    updated.add(id);
    lastTitle = title;
    lastDescription = description;
    lastShift = shift;
    lastBenefits = benefits;
    lastRequirements = requirements;
    return AgencyJobView(
      id: id,
      status: 'open',
      tradeKey: tradeKey ?? 'fitter',
      title: title ?? 'Fitter',
      city: city ?? 'Pune',
      applicantsReceived: 0,
    );
  }

  @override
  Future<List<AgencyJobView>> fetchAgencyJobs() async => const <AgencyJobView>[];
}

const AgencyJobView _job = AgencyJobView(
  id: 'a1',
  status: 'open',
  tradeKey: 'fitter',
  title: 'Fitter',
  city: 'Pune',
  area: 'Chakan',
  applicantsReceived: 4,
);

void main() {
  /// Push the edit screen under a route that can be popped back to, so the
  /// pop-on-success does not empty the navigator.
  ///
  /// The form is taller than the default 600px test viewport and has a STICKY
  /// bottom action, so a scrolled-to widget can still sit under it. A tall
  /// viewport builds every field and keeps every tap a real hit.
  Future<void> open(WidgetTester tester, AgencyJobsCubit cubit) async {
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
                        EditAgencyJobScreen(job: _job, cubit: cubit),
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

  /// Tap Save (it sits at the bottom of a scrolling form) and drain the PATCH +
  /// toast + pop.
  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.text('Save changes'));
    await tester.pump(); // start _save
    await tester.pump(const Duration(seconds: 1)); // PATCH + toast + pop
    // Drain the ~2.4s toast auto-dismiss timer so it does not outlive the test.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  }

  testWidgets('prefills from the job and Save PATCHes the edited title', (
    WidgetTester tester,
  ) async {
    final _ScriptedApi api = _ScriptedApi();
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);

    await open(tester, cubit);

    // Prefilled from the job.
    expect(find.text('Edit job'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Fitter'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Pune'), findsOneWidget);

    // Edit the title.
    await tester.enterText(find.byType(TextField).first, 'Senior Fitter');
    await tester.pump();

    await save(tester);

    expect(api.updated, <String>['a1']);
    expect(api.lastTitle, 'Senior Fitter');
  });

  testWidgets('untouched worker-visible fields send NOTHING (no wipe)', (
    WidgetTester tester,
  ) async {
    final _ScriptedApi api = _ScriptedApi();
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);

    await open(tester, cubit);

    // The agency view returns the four content fields since #1647, so the
    // section is prefilled rather than carrying an "typing here overwrites"
    // warning. What must still hold: an UNTOUCHED field sends nothing, so a
    // save that edits only the title can never wipe stored content.
    expect(find.text('Description (optional)'), findsOneWidget);

    await save(tester);

    expect(api.updated, <String>['a1']);
    expect(api.lastDescription, isNull);
    expect(api.lastShift, isNull);
    expect(api.lastBenefits, isNull);
    expect(api.lastRequirements, isNull);
  });

  testWidgets('typed description, shift and chips ride the PATCH', (
    WidgetTester tester,
  ) async {
    final _ScriptedApi api = _ScriptedApi();
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);

    await open(tester, cubit);

    // Type into the description (the only multiline field on the form).
    final Finder description = find.descendant(
      of: find
          .ancestor(
            of: find.text('Description (optional)'),
            matching: find.byType(Column),
          )
          .first,
      matching: find.byType(TextField),
    );
    await tester.enterText(description, 'Two-shift plant, canteen on site.');
    await tester.pump();

    await tester.tap(find.text('Rotational'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('+ Add benefit'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('add-benefit-field')),
      'PF + ESI',
    );
    await tester.tap(find.text('Add'));
    await tester.pumpAndSettle();

    await save(tester);

    expect(api.lastDescription, 'Two-shift plant, canteen on site.');
    expect(api.lastShift, 'rotational');
    expect(api.lastBenefits, <String>['PF + ESI']);
    // Requirements were never touched → still omitted.
    expect(api.lastRequirements, isNull);
  });

  testWidgets('a chip list emptied on purpose sends [] so it CLEARS', (
    WidgetTester tester,
  ) async {
    final _ScriptedApi api = _ScriptedApi();
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);

    await open(tester, cubit);

    await tester.tap(find.text('+ Add requirement'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('add-requirement-field')),
      'Fanuc control',
    );
    await tester.tap(find.text('Add'));
    await tester.pumpAndSettle();

    // …then remove it again: TOUCHED-but-empty is the only way to clear the
    // stored chips, and it must not be confused with "left alone".
    await tester.tap(find.text('Fanuc control'));
    await tester.pumpAndSettle();

    await save(tester);

    expect(api.lastRequirements, isEmpty);
    expect(api.lastBenefits, isNull);
  });
}
