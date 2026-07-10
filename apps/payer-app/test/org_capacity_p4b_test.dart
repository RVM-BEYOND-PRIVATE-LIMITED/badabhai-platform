import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// PASS P4b — ORG/TEAM members (ADR-0027) + hiring CAPACITY (ADR-0016), over
/// `HttpPayerApiClient` driven by a mock `http.Client`. Verifies: the masked
/// members list (bare array wrapped under `items`, is_self), the OWNER-only
/// invite body (`recruiter` only, no payer_id/org_id) + 409, remove
/// (DELETE path, no body) + 409-owner, accept-invite (token body) + 404/403,
/// capacity GET, and the MIXED-casing capacity buy (top-level snake + nested
/// camelCase quote.finalInr + resumed_plan_ids).
class _Router {
  _Router(this.routes);
  final Map<String, http.Response> routes;
  final List<http.Request> seen = <http.Request>[];

  http.Client client() => MockClient((http.Request req) async {
        seen.add(req);
        final String key = '${req.method} ${req.url.path}';
        return routes[key] ?? http.Response('{}', 404);
      });
}

({HttpPayerApiClient api, _Router router}) _harness(
  Map<String, http.Response> routes,
) {
  final _Router router = _Router(routes);
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok-owner', payerId: 'p', role: 'employer');
  final PayerHttp httpClient = PayerHttp(
    baseUrl: 'http://api.test',
    tokenStore: tokens,
    client: router.client(),
  );
  return (api: HttpPayerApiClient(httpClient), router: router);
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

Map<String, dynamic> _member({
  required String id,
  String orgRole = 'recruiter',
  String status = 'active',
  String emailMasked = 'r•••@acme.in',
  bool isSelf = false,
}) =>
    <String, dynamic>{
      'member_id': id,
      'org_role': orgRole,
      'status': status,
      'email_masked': emailMasked,
      'invited_at': '2026-07-01T00:00:00Z',
      'is_self': isSelf,
    };

void main() {
  group('P4b — org members list', () {
    test('parses a BARE array (wrapped under items); masked email + is_self',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/org/members': _json(<dynamic>[
          _member(
            id: 'm-owner',
            orgRole: 'owner',
            emailMasked: 'o•••@acme.in',
            isSelf: true,
          ),
          _member(id: 'm-rec', status: 'invited', emailMasked: 'n•••@acme.in'),
        ]),
      });

      final List<OrgMemberView> members = await h.api.fetchOrgMembers();

      expect(members, hasLength(2));
      final OrgMemberView owner = members.first;
      expect(owner.memberId, 'm-owner');
      expect(owner.isOwner, isTrue);
      expect(owner.isSelf, isTrue);
      expect(owner.emailMasked, 'o•••@acme.in');
      expect(members[1].isInvited, isTrue);
      expect(members[1].isOwner, isFalse);
      expect(h.router.seen.single.url.path, '/payer/org/members');
      expect(h.router.seen.single.headers['authorization'], 'Bearer tok-owner');
    });
  });

  group('P4b — invite', () {
    test('OWNER invite → recruiter-only body, no payer_id/org_id', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/org/members': _json(
          _member(id: 'm-new', status: 'invited', emailMasked: 'r•••@acme.in'),
          201,
        ),
      });

      final OrgMemberView member =
          await h.api.inviteOrgMember(email: 'recruit@acme.in');

      expect(member.memberId, 'm-new');
      expect(member.isInvited, isTrue);
      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/org/members');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['email'], 'recruit@acme.in');
      expect(body['org_role'], 'recruiter'); // recruiter only
      expect(body.containsKey('payer_id'), isFalse);
      expect(body.containsKey('org_id'), isFalse);
    });

    test('409 (already-member / seat cap) → PayerApiException', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/org/members':
            _json(<String, dynamic>{'message': 'already a member'}, 409),
      });

      await expectLater(
        h.api.inviteOrgMember(email: 'dup@acme.in'),
        throwsA(
          isA<PayerApiException>()
              .having((PayerApiException e) => e.isConflict, 'isConflict', true),
        ),
      );
    });
  });

  group('P4b — remove', () {
    test('DELETE /payer/org/members/:id — no body, 200 removed', () async {
      const String id = 'm-rec';
      final h = _harness(<String, http.Response>{
        'DELETE /payer/org/members/$id':
            _json(<String, dynamic>{'member_id': id, 'status': 'removed'}),
      });

      await h.api.removeOrgMember(id);

      final http.Request req = h.router.seen.single;
      expect(req.method, 'DELETE');
      expect(req.url.path, '/payer/org/members/$id');
      expect(req.body, isEmpty);
    });

    test('409 removing the owner → PayerApiException', () async {
      const String id = 'm-owner';
      final h = _harness(<String, http.Response>{
        'DELETE /payer/org/members/$id':
            _json(<String, dynamic>{'message': 'cannot remove owner'}, 409),
      });

      await expectLater(
        h.api.removeOrgMember(id),
        throwsA(
          isA<PayerApiException>()
              .having((PayerApiException e) => e.isConflict, 'isConflict', true),
        ),
      );
    });
  });

  group('P4b — accept invite', () {
    test('POST /payer/org/invites/accept — token body → active member',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/org/invites/accept': _json(
          _member(
            id: 'm-self',
            status: 'active',
            emailMasked: 'y•••@acme.in',
            isSelf: true,
          ),
        ),
      });

      final OrgMemberView member =
          await h.api.acceptOrgInvite(token: 'a-very-long-invite-token-123456');

      expect(member.isActive, isTrue);
      expect(member.isSelf, isTrue);
      final http.Request req = h.router.seen.single;
      expect(req.url.path, '/payer/org/invites/accept');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['token'], 'a-very-long-invite-token-123456');
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('404 bad token / 403 email mismatch → PayerApiException', () async {
      final bad = _harness(<String, http.Response>{
        'POST /payer/org/invites/accept':
            _json(<String, dynamic>{'message': 'unknown token'}, 404),
      });
      await expectLater(
        bad.api.acceptOrgInvite(token: 'nope-nope-nope-1234'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.isNotFound, 'isNotFound', true)),
      );

      final mismatch = _harness(<String, http.Response>{
        'POST /payer/org/invites/accept':
            _json(<String, dynamic>{'message': 'email mismatch'}, 403),
      });
      await expectLater(
        mismatch.api.acceptOrgInvite(token: 'wrong-email-token-1234'),
        throwsA(isA<PayerApiException>().having(
            (PayerApiException e) => e.statusCode, 'statusCode', 403)),
      );
    });
  });

  group('P4b — hiring capacity', () {
    test('GET /payer/capacity → allowance vs used (+ tier/expiry)', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/capacity': _json(<String, dynamic>{
          'payer_id': 'p',
          'max_active_vacancies': 5,
          'active_plan_count': 3,
          'source_tier': 'cap_5',
          'expires_at': '2026-08-07T00:00:00Z',
        }),
      });

      final CapacityView cap = await h.api.fetchCapacity();

      expect(cap.maxActiveVacancies, 5);
      expect(cap.activePlanCount, 3);
      expect(cap.remaining, 2);
      expect(cap.atCapacity, isFalse);
      expect(cap.sourceTier, 'cap_5');
      expect(h.router.seen.single.url.path, '/payer/capacity');
    });

    test('POST /payer/capacity — MIXED casing parse (snake + camel quote)',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/capacity': _json(<String, dynamic>{
          // Top-level snake_case ...
          'payer_id': 'p',
          'max_active_vacancies': 15,
          'source_tier': 'cap_15',
          'expires_at': '2026-08-07T00:00:00Z',
          'resumed_plan_ids': <String>['plan-a', 'plan-b'],
          // ... with a NESTED camelCase quote.
          'quote': <String, dynamic>{'finalInr': 12000, 'realCall': false},
        }, 201),
      });

      final CapacityPurchase r = await h.api.buyCapacity(tier: 'cap_15');

      expect(r.maxActiveVacancies, 15);
      expect(r.sourceTier, 'cap_15');
      expect(r.finalInr, 12000); // nested camelCase read
      expect(r.resumedPlanIds, <String>['plan-a', 'plan-b']);
      final http.Request req = h.router.seen.single;
      expect(req.url.path, '/payer/capacity');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['tier'], 'cap_15');
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('capacity buy 4xx → PayerApiException (never a phantom raise)',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/capacity':
            _json(<String, dynamic>{'message': 'unknown tier'}, 400),
      });

      await expectLater(
        h.api.buyCapacity(tier: 'nope'),
        throwsA(isA<PayerApiException>()),
      );
    });
  });
}
