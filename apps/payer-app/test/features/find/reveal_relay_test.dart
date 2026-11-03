import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/find/presentation/reveal_args.dart';
import 'package:payer_app/features/find/presentation/reveal_screen.dart';

/// The EXISTING reveal, opened from an All-candidates row ([RevealArgs.relay]):
/// the same relay handle and the same masked résumé — requested with NO posting
/// id, because a search unlock has no posting context — and never a name or
/// phone. The applicant path's args keep reading exactly as before.
class _SpyApi extends MockPayerApiClient {
  final List<({String workerId, String? jobPostingId})> disclosures =
      <({String workerId, String? jobPostingId})>[];
  final List<String> reveals = <String>[];

  @override
  Future<RevealResult> reveal(String unlockId) {
    reveals.add(unlockId);
    return super.reveal(unlockId);
  }

  @override
  Future<DisclosureResult> disclose({
    required String workerId,
    String? jobPostingId,
  }) {
    disclosures.add((workerId: workerId, jobPostingId: jobPostingId));
    return super.disclose(workerId: workerId, jobPostingId: jobPostingId);
  }
}

const String _workerId = 'face2000-0000-4000-8000-000000000003';

const RevealArgs _searchReveal = RevealArgs.relay(
  workerId: _workerId,
  unlockId: 'unl-search-1',
  title: 'Worker ••0003',
  facets: <String>['CNC Turner', '4 yrs experience', 'Pune'],
);

void main() {
  late _SpyApi api;
  late List<Uri> launched;

  setUp(() async {
    api = _SpyApi();
    launched = <Uri>[];
    revealSignedUrlLauncher = (Uri url) async {
      launched.add(url);
      return true;
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
    await GetIt.instance.reset();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  });

  tearDown(() {
    revealSignedUrlLauncher = defaultSignedUrlLauncher;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<void> pump(WidgetTester tester, RevealArgs args) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: RevealScreen(args: args, onBack: () {})),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('a search row reveals the relay handle under its masked handle',
      (WidgetTester tester) async {
    await pump(tester, _searchReveal);

    expect(api.reveals, <String>['unl-search-1']);
    expect(find.text('Worker ••0003'), findsOneWidget);
    expect(find.text('CNC Turner · 4 yrs experience · Pune'), findsOneWidget);
    expect(find.text('relay-7Q2X'), findsOneWidget);
    // Nothing identifying — the backend returns none and none is fabricated.
    expect(find.textContaining('+91'), findsNothing);
    expect(find.textContaining('Ramesh'), findsNothing);
  });

  testWidgets('its masked résumé goes out with NO posting id',
      (WidgetTester tester) async {
    await pump(tester, _searchReveal);

    final Finder row = find.text('Masked résumé');
    await tester.ensureVisible(row);
    await tester.tap(row);
    await tester.pumpAndSettle();

    expect(api.disclosures.single.workerId, _workerId);
    expect(api.disclosures.single.jobPostingId, isNull);
    expect(launched, hasLength(1));
  });

  test('the applicant args read exactly as the reveal always showed them', () {
    const Applicant applicant = Applicant(
      workerId: 'a1b2c3d4-5566-4777-8888-99990000abcd',
      rank: 1,
      score: 0.9,
      hot: false,
      pushEligible: false,
      tradeLabel: 'CNC Setter',
      experienceBand: '5-8 yrs',
      cityLabel: 'Pune',
    );
    const RevealArgs args = RevealArgs.real(
      applicant: applicant,
      unlockId: 'u-1',
      jobId: 'job-1',
    );

    expect(args.isReal, isTrue);
    expect(args.workerId, applicant.workerId);
    expect(args.title, 'Worker ••abcd');
    expect(args.facets, <String>['CNC Setter', '5-8 yrs', 'Pune']);
    expect(args.jobId, 'job-1');
  });

  test('a mock reveal is not a real one; a search reveal is', () {
    expect(_searchReveal.isReal, isTrue);
    expect(_searchReveal.applicant, isNull);
    expect(_searchReveal.jobId, isNull);
  });
}
