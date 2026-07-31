import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/referral/presentation/cubit/referral_cubit.dart';

/// ReferralCubit drives the agency Refer-&-earn screen off two real agent-only
/// routes (`GET /payer/agency/referrals/summary`, `POST /payer/agency/invites`).
/// The behaviours worth pinning: a load failure surfaces `error` (never a blank
/// ready screen), and the share signal is BEST-EFFORT — it never throws and
/// no-ops when there is no link to share.
class _ScriptedReferralApi extends MockPayerApiClient {
  ReferralsSummary summary =
      const ReferralsSummary(created: 24, clicked: 11, accepted: 6, minBucket: 5);
  ReferralLink link = const ReferralLink(code: 'APEX-7K2', url: 'badabhai.in/r/APEX-7K2');

  Object? throwOnSummary;
  Object? throwOnLink;
  Object? throwOnClick;

  final List<String> clicked = <String>[];

  @override
  Future<ReferralsSummary> fetchReferralsSummary() async {
    if (throwOnSummary != null) throw throwOnSummary!;
    return summary;
  }

  @override
  Future<ReferralLink> referralLink({String? campaign}) async {
    if (throwOnLink != null) throw throwOnLink!;
    return link;
  }

  @override
  Future<void> recordInviteClick(String code) async {
    clicked.add(code);
    if (throwOnClick != null) throw throwOnClick!;
  }
}

void main() {
  late _ScriptedReferralApi api;
  late ReferralCubit cubit;

  setUp(() {
    api = _ScriptedReferralApi();
    cubit = ReferralCubit(api);
  });

  tearDown(() => cubit.close());

  test('initial state is idle with no link/summary', () {
    expect(cubit.state.status, ReferralStatus.initial);
    expect(cubit.state.link, isNull);
    expect(cubit.state.summary, isNull);
  });

  test('load reads the funnel summary and the invite link', () async {
    await cubit.load();

    expect(cubit.state.status, ReferralStatus.ready);
    expect(cubit.state.summary?.created, 24);
    expect(cubit.state.link?.code, 'APEX-7K2');
  });

  test('a failed summary read surfaces error, not a blank ready screen',
      () async {
    api.throwOnSummary = const PayerApiException(503);

    await cubit.load();

    expect(cubit.state.status, ReferralStatus.error);
  });

  test('a failed link mint also surfaces error', () async {
    api.throwOnLink = const PayerApiException(500);

    await cubit.load();

    expect(cubit.state.status, ReferralStatus.error);
  });

  test('recordShare posts a click for the loaded link code', () async {
    await cubit.load();

    await cubit.recordShare();

    expect(api.clicked, <String>['APEX-7K2']);
  });

  test('recordShare is a no-op before a link is loaded', () async {
    await cubit.recordShare();

    expect(api.clicked, isEmpty);
  });

  test('recordShare swallows an error — it is a best-effort funnel signal',
      () async {
    await cubit.load();
    api.throwOnClick = Exception('socket closed');

    // Must not throw.
    await cubit.recordShare();

    expect(api.clicked, <String>['APEX-7K2']);
    expect(cubit.state.status, ReferralStatus.ready,
        reason: 'a share blip must never knock the screen out of ready');
  });
}
