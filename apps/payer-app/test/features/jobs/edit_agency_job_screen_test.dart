import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/cubit/agency_jobs_cubit.dart';
import 'package:payer_app/features/jobs/presentation/edit_agency_job_screen.dart';

/// The agency edit screen is prefilled from the [AgencyJobView] and a Save
/// drives the shared cubit's PATCH. These pin the two things a form regresses
/// on: the prefill (an empty form would silently wipe fields) and that Save
/// actually reaches `updateAgencyJob` with the edited value.
class _ScriptedApi extends MockPayerApiClient {
  final List<String> updated = <String>[];
  String? lastTitle;

  @override
  Future<AgencyJobView> updateAgencyJob(
    String id, {
    String? tradeKey,
    String? title,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
  }) async {
    updated.add(id);
    lastTitle = title;
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
  testWidgets('prefills from the job and Save PATCHes the edited title', (
    WidgetTester tester,
  ) async {
    final _ScriptedApi api = _ScriptedApi();
    final AgencyJobsCubit cubit = AgencyJobsCubit(api);
    addTearDown(cubit.close);

    // Host the screen under a route that can be popped back to, so the
    // pop-on-success does not empty the navigator.
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

    // Prefilled from the job.
    expect(find.text('Edit job'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Fitter'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Pune'), findsOneWidget);

    // Edit the title.
    await tester.enterText(find.byType(TextField).first, 'Senior Fitter');
    await tester.pump();

    // Save sits at the bottom of a scrolling form — bring it into view first.
    await tester.scrollUntilVisible(
      find.text('Save changes'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Save changes'));
    await tester.pump(); // start _save
    await tester.pump(const Duration(seconds: 1)); // PATCH + toast + pop
    // Drain the ~2.4s toast auto-dismiss timer so it does not outlive the test.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();

    expect(api.updated, <String>['a1']);
    expect(api.lastTitle, 'Senior Fitter');
  });
}
