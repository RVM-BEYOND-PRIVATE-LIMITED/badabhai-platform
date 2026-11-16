import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/widgets/posting_audience_fields.dart';

/// #2746 — the audience picker is presentation only: it shows the branch/course
/// selectors only when the audience has an RVM part, and tells the company when
/// an edit to an approved posting sends it back to review.
const AudienceOptions _options = AudienceOptions(
  audiences: <JobAudience>[
    JobAudience.badabhaiWorkers,
    JobAudience.rvmStudents,
    JobAudience.both,
  ],
  branches: <AudienceBranchOption>[
    AudienceBranchOption(id: 1, label: 'Pune'),
    AudienceBranchOption(id: 2, label: 'Nashik'),
  ],
  courses: <AudienceCourseOption>[
    AudienceCourseOption(id: 'cnc', label: 'CNC Operator'),
  ],
);

Future<void> _pump(
  WidgetTester tester, {
  required JobAudience audience,
  RvmReview? review,
}) async {
  JobAudience current = audience;
  await tester.pumpWidget(
    MaterialApp(
      home: StatefulBuilder(
        builder: (BuildContext context, StateSetter setState) => Scaffold(
          body: SingleChildScrollView(
            child: PostingAudienceFields(
              options: _options,
              audience: current,
              branchIds: const <int>{},
              courseIds: const <String>{},
              review: review,
              onChanged: (
                JobAudience next,
                Set<int> _,
                Set<String> __,
              ) {
                setState(() => current = next);
              },
            ),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('a BadaBhai-only audience hides branch and course targeting',
      (WidgetTester tester) async {
    await _pump(tester, audience: JobAudience.badabhaiWorkers);
    expect(find.text('Branches'), findsNothing);
    expect(find.text('Courses'), findsNothing);
    expect(find.text('Pune'), findsNothing);
  });

  testWidgets('choosing Both reveals the targeting, with empty = all guidance',
      (WidgetTester tester) async {
    await _pump(tester, audience: JobAudience.badabhaiWorkers);
    await tester.tap(find.text('Both'));
    await tester.pumpAndSettle();
    expect(find.text('Branches'), findsOneWidget);
    expect(find.text('Courses'), findsOneWidget);
    expect(find.text('Leave all unticked to target every branch.'), findsOneWidget);
    expect(find.text('Pune'), findsOneWidget);
    expect(find.text('CNC Operator'), findsOneWidget);
  });

  testWidgets('an approved review warns that a student-visible edit returns to pending',
      (WidgetTester tester) async {
    await _pump(
      tester,
      audience: JobAudience.both,
      review: const RvmReview(state: 'approved'),
    );
    expect(find.textContaining('sends it back to pending'), findsOneWidget);
  });
}
