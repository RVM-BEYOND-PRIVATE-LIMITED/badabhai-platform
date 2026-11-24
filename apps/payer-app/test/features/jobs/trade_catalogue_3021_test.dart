import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';
import 'package:payer_app/features/jobs/presentation/widgets/trade_posting_fields.dart';

const List<PostingTradeCatalogueRow> _catalogue = <PostingTradeCatalogueRow>[
  PostingTradeCatalogueRow(
    roleKind: 'welder',
    roleLabel: 'Welder',
    department: 'fabrication_welding',
    departmentLabel: 'Fabrication & Welding',
    kind: 'shop_floor',
  ),
  PostingTradeCatalogueRow(
    roleKind: 'fitter',
    roleLabel: 'Fitter',
    department: 'fabrication_welding',
    departmentLabel: 'Fabrication & Welding',
    kind: 'shop_floor',
  ),
  PostingTradeCatalogueRow(
    roleKind: 'cnc_turner',
    roleLabel: 'CNC Turner',
    department: 'machining',
    departmentLabel: 'Machining',
    kind: 'shop_floor',
  ),
];

class _CatalogueJobsApi extends MockPayerApiClient {
  _CatalogueJobsApi(
      {required this.jobs, this.trades = const <PostingTradeForm>[]});

  final List<JobPosting> jobs;
  final List<PostingTradeForm> trades;

  @override
  Future<List<JobPosting>> fetchJobs({String? status}) async => jobs;

  @override
  Future<List<PostingTradeForm>> fetchPostingTrades() async => trades;
}

JobPosting _job({required String roleKind, required String title}) =>
    JobPosting(
      title: title,
      band: '2-5',
      filled: 0,
      quota: 0,
      applicants: 0,
      unlocks: 0,
      status: JobStatus.live,
      verified: false,
      boosted: false,
      id: 'job-1',
      city: 'Pune',
      wireStatus: 'open',
      roleKind: roleKind,
    );

Future<void> _pumpJobs(WidgetTester tester, _CatalogueJobsApi api) async {
  await GetIt.instance.reset();
  setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  await tester.pumpWidget(
    MaterialApp(home: Scaffold(body: JobsScreen(onPost: () {}))),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
      'the picker groups trades under server departments and searches '
      'the server role label', (WidgetTester tester) async {
    String? picked;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (BuildContext context, StateSetter setState) =>
                PostingTradePicker(
              catalogue: _catalogue,
              value: picked,
              onSelected: (String kind) => setState(() => picked = kind),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(PostingTradePicker.fieldKey));
    await tester.pumpAndSettle();

    expect(find.text('Fabrication & Welding'), findsOneWidget);
    expect(find.text('Machining'), findsOneWidget);
    expect(find.text('Welder'), findsOneWidget);
    expect(find.text('CNC Turner'), findsOneWidget);

    await tester.enterText(
      find.byKey(PostingTradePicker.searchFieldKey),
      'weld',
    );
    await tester.pumpAndSettle();

    expect(find.text('Fabrication & Welding'), findsOneWidget);
    expect(find.text('Welder'), findsOneWidget);
    expect(find.text('Fitter'), findsNothing);
    expect(find.text('CNC Turner'), findsNothing);
    expect(find.text('Machining'), findsNothing);

    await tester.tap(find.text('Welder'));
    await tester.pumpAndSettle();

    expect(picked, 'welder');
    expect(find.text('Welder'), findsOneWidget);
  });

  testWidgets('an unknown role kind still reads a title-cased name', (
    WidgetTester tester,
  ) async {
    await _pumpJobs(
      tester,
      _CatalogueJobsApi(
        jobs: <JobPosting>[
          _job(roleKind: 'future_robot_operator', title: 'Shop hand'),
        ],
      ),
    );

    expect(find.text('Shop hand'), findsOneWidget);
    expect(find.textContaining('Future Robot Operator'), findsOneWidget);
  });

  testWidgets("a new trade's card shows the catalogue's server label", (
    WidgetTester tester,
  ) async {
    await _pumpJobs(
      tester,
      _CatalogueJobsApi(
        jobs: <JobPosting>[
          _job(roleKind: 'laser_cutting_operator', title: 'Sheet cutting'),
        ],
        trades: const <PostingTradeForm>[
          PostingTradeForm(
            roleKind: 'laser_cutting_operator',
            roleLabel: 'Laser Cutting Operator',
            packId: 'qp_laser_cutting',
            matchSkillId: 'mskill_laser_cutting',
            department: 'sheet_metal',
          ),
        ],
      ),
    );

    expect(find.text('Sheet cutting'), findsOneWidget);
    expect(find.textContaining('Laser Cutting Operator'), findsOneWidget);
  });
}
