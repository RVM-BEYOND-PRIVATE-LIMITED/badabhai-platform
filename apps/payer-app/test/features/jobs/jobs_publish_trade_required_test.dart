import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/widgets/bb_shake.dart';
import 'package:payer_app/features/jobs/presentation/jobs_screen.dart';

/// #2635, end to end through the REAL HTTP client: a company job matches only
/// within the 16 postable trades, so `PATCH /payer/job-postings/:id` refuses to
/// PUBLISH a draft that names none of them — a 400 whose `error.reason` is
/// `posting_trade_required`.
///
/// Tapping Publish on such a draft must open the trade picker (the job's edit
/// form, refused AT its role), never a toast — and never the server's own
/// sentence. Any OTHER refusal still says why in a toast.
const String _jobId = 'cccccccc-0000-4000-8000-000000000003';

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

/// A card-complete DRAFT with no trade — the 2026-11-03 shape the server now
/// refuses to publish.
const Map<String, dynamic> _draftRow = <String, dynamic>{
  'id': _jobId,
  'role_title': 'Welder',
  'vacancy_band': '2-5',
  'status': 'draft',
  'city': 'Pune',
  'pay_min': 18000,
  'pay_max': 24000,
  'pay_type': 'in_hand',
  'min_experience_years': 1,
  'max_experience_years': 4,
  'shift': 'day',
  'needed_by': 'soon',
  'description': 'Fabrication welding on site.',
  'benefits': <String>['PF + ESI'],
  'requirements': <String>['MIG welding'],
  'role_kind': null,
  'match_skill_ids': <String>[],
};

/// The 400 exactly as the API's wire test renders it (nested under `error`).
http.Response _tradeRequired() => _json(
      <String, dynamic>{
        'statusCode': 400,
        'requestId': 'req-test',
        'path': '/payer/job-postings/$_jobId',
        'timestamp': '2026-11-04T12:00:00.000Z',
        'error': <String, dynamic>{
          'statusCode': 400,
          'error': 'Bad Request',
          'message': 'a live job must name one of the 16 trades',
          'reason': 'posting_trade_required',
        },
      },
      400,
    );

/// Two trades of the 16 — enough to pick from.
const Map<String, dynamic> _catalogue = <String, dynamic>{
  'trades': <Map<String, dynamic>>[
    <String, dynamic>{
      'role_kind': 'welder',
      'role_label': 'Welder',
      'pack_id': 'qp_welding_trade',
      'match_skill_id': 'mskill_welder',
    },
    <String, dynamic>{
      'role_kind': 'fitter',
      'role_label': 'Fitter',
      'pack_id': 'qp_fitter',
      'match_skill_id': 'mskill_fitter',
    },
  ],
};

void main() {
  late List<http.Request> seen;

  Future<void> pump(WidgetTester tester, http.Response publishResponse) async {
    seen = <http.Request>[];
    final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
    // ignore: discarded_futures
    tokens.save(accessToken: 'tok', payerId: 'p', role: 'company');
    final HttpPayerApiClient api = HttpPayerApiClient(PayerHttp(
      baseUrl: 'http://api.test',
      tokenStore: tokens,
      client: MockClient((http.Request req) async {
        seen.add(req);
        return switch ('${req.method} ${req.url.path}') {
          'GET /payer/job-postings' => _json(<dynamic>[_draftRow]),
          'GET /payer/posting-trades' => _json(_catalogue),
          'PATCH /payer/job-postings/$_jobId' => publishResponse,
          _ => http.Response('{}', 404),
        };
      }),
    ));
    await GetIt.instance.reset();
    // No session → the company branch (the agency one has no Publish).
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());

    tester.view.physicalSize = const Size(1000, 4000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: JobsScreen(onPost: () {}))),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
      'a Publish refused for want of a trade opens the trade picker, refused '
      'there — no toast, never the server message', (WidgetTester tester) async {
    await pump(tester, _tradeRequired());

    await tester.tap(find.text('Publish'));
    await tester.pumpAndSettle();

    // The publish was asked for…
    final http.Request patch =
        seen.singleWhere((http.Request r) => r.method == 'PATCH');
    expect(jsonDecode(patch.body), <String, dynamic>{'status': 'open'});

    // …and the refusal opened the job's form at its trade picker.
    expect(find.text('Edit job'), findsOneWidget);
    expect(find.text('Welder'), findsWidgets);
    expect(find.text('Fitter'), findsOneWidget);
    expect(
      find.descendant(
        of: find.ancestor(of: find.text('Role'), matching: find.byType(BbShake)),
        matching: find.text('Pick one of the 16 trades'),
      ),
      findsOneWidget,
    );
    expect(find.byType(SnackBar), findsNothing);
    expect(find.textContaining('a live job must name'), findsNothing);
  });

  testWidgets('any other Publish refusal still says why, in a toast', (
    WidgetTester tester,
  ) async {
    await pump(
      tester,
      _json(<String, dynamic>{
        'statusCode': 409,
        'error': <String, dynamic>{'message': 'Conflict'},
      }, 409),
    );

    await tester.tap(find.text('Publish'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('Edit job'), findsNothing);
    expect(
      find.descendant(
        of: find.byType(SnackBar),
        matching: find.text("This job can't be published."),
      ),
      findsOneWidget,
    );
    // Drain the toast's auto-dismiss timer.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}
