import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/agency/presentation/cubit/agency_earnings_cubit.dart';
import 'package:payer_app/features/agency/presentation/cubit/agency_kyc_cubit.dart';
import 'package:payer_app/features/agency/presentation/cubit/agency_payouts_cubit.dart';

/// P1 — the three agency supply-money cubits. The behaviour worth guarding
/// hardest is the FLAG-GATE DEGRADE: a neutral 404 must land on a distinct
/// "unavailable" state (never a crash / generic error), and a 403 (company
/// session) on "forbidden". Also: the payout request reflects the SERVER gate
/// (ok vs blocked) and never re-derives eligibility on the client.
class _ScriptedApi extends MockPayerApiClient {
  AgencyEarnings? earnings;
  Object? throwOnEarnings;

  PayoutRequestResult? payoutResult;
  Object? throwOnPayout;

  AgencyKycView? kyc;
  Object? throwOnKycRead;
  AgencyKycView? kycSubmitResult;
  Object? throwOnKycSubmit;

  List<AgencyPayout>? payouts;
  Object? throwOnPayouts;

  int earningsFetches = 0;

  @override
  Future<AgencyEarnings> fetchAgencyEarnings() async {
    earningsFetches++;
    if (throwOnEarnings != null) throw throwOnEarnings!;
    return earnings ?? _earnings();
  }

  @override
  Future<PayoutRequestResult> requestAgencyPayout() async {
    if (throwOnPayout != null) throw throwOnPayout!;
    return payoutResult ??
        const PayoutRequestResult(
            ok: true, requestId: 'r', amountInr: 850, accrualCount: 85);
  }

  @override
  Future<AgencyKycView> fetchAgencyKyc() async {
    if (throwOnKycRead != null) throw throwOnKycRead!;
    return kyc ?? const AgencyKycView(status: 'not_submitted');
  }

  @override
  Future<AgencyKycView> submitAgencyKyc({
    required String pan,
    required String bankAccount,
    required String ifsc,
    required String accountHolderName,
  }) async {
    if (throwOnKycSubmit != null) throw throwOnKycSubmit!;
    return kycSubmitResult ??
        const AgencyKycView(status: 'pending', panLast4: '234F', bankLast4: '9012');
  }

  @override
  Future<List<AgencyPayout>> fetchAgencyPayouts() async {
    if (throwOnPayouts != null) throw throwOnPayouts!;
    return payouts ?? const <AgencyPayout>[];
  }
}

AgencyEarnings _earnings({
  int requestable = 850,
  bool canRequest = true,
  String? blocked,
  String kyc = 'verified',
}) =>
    AgencyEarnings(
      totalAccruedInr: 1350,
      requestableInr: requestable,
      inRequestInr: 0,
      paidInr: 500,
      accrualCount: 135,
      kycStatus: kyc,
      thresholdInr: 500,
      basisInr: 40,
      rateBps: 2500,
      windowDays: 90,
      payoutsEnabled: true,
      canRequest: canRequest,
      blockedReason: blocked,
    );

void main() {
  group('AgencyEarningsCubit', () {
    late _ScriptedApi api;
    late AgencyEarningsCubit cubit;

    setUp(() {
      api = _ScriptedApi();
      cubit = AgencyEarningsCubit(api);
    });
    tearDown(() => cubit.close());

    test('load → ready with the earnings view', () async {
      api.earnings = _earnings();
      await cubit.load();
      expect(cubit.state.status, AgencyEarningsStatus.ready);
      expect(cubit.state.earnings!.requestableInr, 850);
    });

    test('a FLAG-OFF 404 degrades to unavailable (not error/crash)', () async {
      api.throwOnEarnings = const PayerApiException(404);
      await cubit.load();
      expect(cubit.state.status, AgencyEarningsStatus.unavailable);
    });

    test('a company 403 degrades to forbidden', () async {
      api.throwOnEarnings = const PayerApiException(403);
      await cubit.load();
      expect(cubit.state.status, AgencyEarningsStatus.forbidden);
    });

    test('any other outage is a generic error', () async {
      api.throwOnEarnings = const PayerApiException(503);
      await cubit.load();
      expect(cubit.state.status, AgencyEarningsStatus.error);
    });

    test('requestPayout ok → refetches and returns a success message', () async {
      api.earnings = _earnings();
      await cubit.load();
      api.earningsFetches = 0;
      api.payoutResult = const PayoutRequestResult(
          ok: true, requestId: 'r1', amountInr: 850, accrualCount: 85);

      final PayoutActionResult result = await cubit.requestPayout();

      expect(result.success, isTrue);
      expect(result.message, contains('850'));
      expect(api.earningsFetches, 1, reason: 'success refetches the balances');
    });

    test('requestPayout blocked → honest message, no crash', () async {
      api.earnings = _earnings();
      await cubit.load();
      api.payoutResult =
          const PayoutRequestResult(ok: false, blockedReason: 'kyc_not_verified');

      final PayoutActionResult result = await cubit.requestPayout();

      expect(result.success, isFalse);
      expect(result.message, contains('KYC'));
    });

    test('requestPayout that 404s mid-flow degrades to unavailable', () async {
      api.earnings = _earnings();
      await cubit.load();
      api.throwOnPayout = const PayerApiException(404);

      final PayoutActionResult result = await cubit.requestPayout();

      expect(result.success, isFalse);
      expect(cubit.state.status, AgencyEarningsStatus.unavailable);
    });
  });

  group('AgencyKycCubit', () {
    late _ScriptedApi api;
    late AgencyKycCubit cubit;

    setUp(() {
      api = _ScriptedApi();
      cubit = AgencyKycCubit(api);
    });
    tearDown(() => cubit.close());

    test('load → ready with the masked status', () async {
      api.kyc = const AgencyKycView(status: 'verified', panLast4: '234F');
      await cubit.load();
      expect(cubit.state.status, AgencyKycStatus.ready);
      expect(cubit.state.kyc!.isVerified, isTrue);
    });

    test('a FLAG-OFF 404 degrades to unavailable', () async {
      api.throwOnKycRead = const PayerApiException(404);
      await cubit.load();
      expect(cubit.state.status, AgencyKycStatus.unavailable);
    });

    test('submit success updates the in-state masked view', () async {
      api.kyc = const AgencyKycView(status: 'not_submitted');
      await cubit.load();
      api.kycSubmitResult = const AgencyKycView(
          status: 'pending', panLast4: '234F', bankLast4: '9012');

      final KycSubmitResult result = await cubit.submit(
        pan: 'ABCDE1234F',
        bankAccount: '123456789012',
        ifsc: 'HDFC0001234',
        accountHolderName: 'Acme',
      );

      expect(result.success, isTrue);
      expect(cubit.state.kyc!.isPending, isTrue);
      expect(cubit.state.kyc!.panLast4, '234F');
    });

    test('a 400 (bad format) is an honest, no-oracle message', () async {
      api.kyc = const AgencyKycView(status: 'not_submitted');
      await cubit.load();
      api.throwOnKycSubmit = const PayerApiException(400);

      final KycSubmitResult result = await cubit.submit(
        pan: 'x',
        bankAccount: '1',
        ifsc: 'y',
        accountHolderName: 'A',
      );

      expect(result.success, isFalse);
      expect(cubit.state.status, AgencyKycStatus.ready);
    });

    test('a 409 (duplicate PAN) never echoes the PAN', () async {
      api.kyc = const AgencyKycView(status: 'not_submitted');
      await cubit.load();
      api.throwOnKycSubmit = const PayerApiException(409);

      final KycSubmitResult result = await cubit.submit(
        pan: 'ABCDE1234F',
        bankAccount: '123456789012',
        ifsc: 'HDFC0001234',
        accountHolderName: 'Acme',
      );

      expect(result.success, isFalse);
      expect(result.message, isNot(contains('ABCDE1234F')));
    });
  });

  group('AgencyPayoutsCubit', () {
    late _ScriptedApi api;
    late AgencyPayoutsCubit cubit;

    setUp(() {
      api = _ScriptedApi();
      cubit = AgencyPayoutsCubit(api);
    });
    tearDown(() => cubit.close());

    test('load → ready with the history rows', () async {
      api.payouts = const <AgencyPayout>[
        AgencyPayout(
            id: 'p1', amountInr: 500, accrualCount: 50, status: 'paid'),
      ];
      await cubit.load();
      expect(cubit.state.resolvedStatus, AgencyPayoutsStatus.ready);
      expect(cubit.state.payouts, hasLength(1));
    });

    test('an empty-but-OK load resolves to the empty view', () async {
      api.payouts = const <AgencyPayout>[];
      await cubit.load();
      expect(cubit.state.resolvedStatus, AgencyPayoutsStatus.empty);
    });

    test('a FLAG-OFF 404 degrades to unavailable', () async {
      api.throwOnPayouts = const PayerApiException(404);
      await cubit.load();
      expect(cubit.state.status, AgencyPayoutsStatus.unavailable);
    });

    test('a company 403 degrades to forbidden', () async {
      api.throwOnPayouts = const PayerApiException(403);
      await cubit.load();
      expect(cubit.state.status, AgencyPayoutsStatus.forbidden);
    });
  });
}
