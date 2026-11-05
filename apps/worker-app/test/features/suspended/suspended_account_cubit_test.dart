import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/features/suspended/presentation/cubit/suspended_account_cubit.dart';

void main() {
  group('SuspendedAccountCubit DPDP exits', () {
    test(
      'delete request/confirm use ONLY the restricted token as bearer',
      () async {
        final List<http.Request> requests = <http.Request>[];
        final ApiClient api = ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            requests.add(req);
            if (req.url.path.endsWith('/request')) {
              return http.Response(
                jsonEncode(<String, dynamic>{
                  'success': true,
                  'resend_in_seconds': 30,
                }),
                200,
              );
            }
            return http.Response(
              jsonEncode(<String, dynamic>{
                'success': true,
                'scheduled_for': '2026-07-21T12:00:00.000Z',
              }),
              200,
            );
          }),
        );
        final SuspendedAccountCubit cubit = SuspendedAccountCubit(
          restrictedToken: 'restricted-1',
          api: api,
        );
        addTearDown(cubit.close);

        expect(cubit.hasRestrictedToken, isTrue);
        await cubit.requestDelete();
        expect(cubit.state.status, SuspendedAccountStatus.otpSent);
        expect(requests.single.url.path, '/auth/account/delete/request');
        expect(requests.single.headers['authorization'], 'Bearer restricted-1');

        await cubit.confirmDelete('1234');
        expect(cubit.state.status, SuspendedAccountStatus.deletionScheduled);
        expect(requests.last.url.path, '/auth/account/delete/confirm');
        expect(requests.last.headers['authorization'], 'Bearer restricted-1');
        expect(cubit.state.scheduledFor, DateTime.utc(2026, 7, 21, 12));
      },
    );

    test(
      'consent withdrawal uses the restricted token and reports success',
      () async {
        late http.Request captured;
        final ApiClient api = ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            captured = req;
            return http.Response(
              jsonEncode(<String, dynamic>{'ok': true}),
              200,
            );
          }),
        );
        final SuspendedAccountCubit cubit = SuspendedAccountCubit(
          restrictedToken: 'restricted-2',
          api: api,
        );
        addTearDown(cubit.close);

        await cubit.withdrawConsent();

        expect(cubit.state.status, SuspendedAccountStatus.consentWithdrawn);
        expect(captured.url.path, '/consent/withdraw');
        expect(captured.headers['authorization'], 'Bearer restricted-2');
      },
    );

    test('without a restricted token no DPDP request is made', () async {
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls++;
          return http.Response('{}', 200);
        }),
      );
      final SuspendedAccountCubit cubit = SuspendedAccountCubit(api: api);
      addTearDown(cubit.close);

      expect(cubit.hasRestrictedToken, isFalse);
      await cubit.requestDelete();
      await cubit.withdrawConsent();

      expect(calls, 0);
      expect(cubit.state.status, SuspendedAccountStatus.error);
    });
  });
}
