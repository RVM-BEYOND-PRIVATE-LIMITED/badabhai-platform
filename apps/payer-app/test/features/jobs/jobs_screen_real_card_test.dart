import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';

/// The REAL company job card now renders honest, backend-sourced signals: the
/// applicant-visibility quota meter (used / effective quota) and a Boosted badge
/// when a boost is active — sourced from the enriched `GET /payer/job-postings`
/// (active plan + boost join), not fabricated. A plan-less card shows neither.
class _RealJobsApi extends MockPayerApiClient {
  _RealJobsApi(this._jobs);

  final List<JobPosting> _jobs;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async => _jobs;
}

JobPosting _job({
  required String id,
  required int quota,
  required int filled,
  required bool boosted,
  bool verified = false,
  int disclosuresCount = 0,
}) =>
    JobPosting(
      title: 'VMC Operator',
      band: '2-5',
      filled: filled,
      quota: quota,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.live,
      verified: verified,
      boosted: boosted,
      id: id,
      wireStatus: 'open',
      locationLabel: 'Pune',
      disclosuresCount: disclosuresCount,
    );

Future<void> _pump(WidgetTester tester, List<JobPosting> jobs) async {
  await GetIt.instance.reset();
  // No session → company branch (JobsScreen defaults to the company view).
  setupLocator(
    apiClient: _RealJobsApi(jobs),
    secureStore: InMemoryKeyValueStore(),
  );
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: JobsScreen(onPost: () {}))),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
      'a verified + plan + boost posting shows Verified + Boosted badges + quota meter',
      (WidgetTester tester) async {
    await _pump(tester, <JobPosting>[
      _job(
        id: 'job-1',
        quota: 40,
        filled: 12,
        boosted: true,
        verified: true,
        disclosuresCount: 7,
      ),
    ]);

    expect(find.text('VMC Operator'), findsOneWidget);
    expect(find.text('Verified job'), findsOneWidget);
    expect(find.text('Boosted'), findsOneWidget);
    expect(find.text('Applicant views'), findsOneWidget);
    expect(find.text('12/40'), findsOneWidget);
    // Truthful per-posting engagement (résumés downloaded) shows in the meta line.
    expect(find.textContaining('7 résumés downloaded'), findsOneWidget);
    // The edit affordance the same card gained.
    expect(find.text('Edit details'), findsOneWidget);
  });

  testWidgets('an unverified plan-less posting shows none of the earned badges', (
    WidgetTester tester,
  ) async {
    await _pump(tester, <JobPosting>[
      _job(id: 'job-2', quota: 0, filled: 0, boosted: false),
    ]);

    expect(find.text('VMC Operator'), findsOneWidget);
    expect(find.text('Verified job'), findsNothing);
    expect(find.text('Boosted'), findsNothing);
    expect(find.text('Applicant views'), findsNothing);
  });
}
