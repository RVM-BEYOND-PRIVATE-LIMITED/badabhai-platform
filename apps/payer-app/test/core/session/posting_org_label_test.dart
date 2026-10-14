import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/payer_account_api.dart';
import 'package:payer_app/core/session/app_session.dart';

/// ── #2194 (ADR-0053 O-10): which org a POSTING goes out under ─────────────
///
/// `orgName` is the person's own account label. A recruiter on a team posts on
/// the TEAM's behalf, so defaulting `org_label` to their own label named the
/// wrong company on a worker-facing card. `postingOrgName` is the founder's
/// company for exactly that case, and equals `orgName` for everyone else.
void main() {
  PayerAccount account({required String name, String? postingOrgName}) =>
      PayerAccount(
        name: name,
        plan: 'Company account',
        initials: 'KI',
        postingOrgName: postingOrgName,
      );

  group('postingOrgLabelFor', () {
    test('solo payer, or tenancy off: the account org', () {
      expect(
        postingOrgLabelFor(
          account(
            name: 'Kalyani Industries',
            postingOrgName: 'Kalyani Industries',
          ),
        ),
        'Kalyani Industries',
      );
    });

    test("team member with tenancy on: the FOUNDER's org, not their own", () {
      expect(
        postingOrgLabelFor(
          account(name: 'Ravi Staffing', postingOrgName: 'Sunrise Agency'),
        ),
        'Sunrise Agency',
      );
    });

    test('an older API that sends no such field keeps the account org', () {
      expect(
        postingOrgLabelFor(account(name: 'Kalyani Industries')),
        'Kalyani Industries',
      );
    });

    test('null (tenancy denied) and blank fall back safely', () {
      expect(
        postingOrgLabelFor(
          account(name: 'Kalyani Industries', postingOrgName: null),
        ),
        'Kalyani Industries',
      );
      expect(
        postingOrgLabelFor(
          account(name: 'Kalyani Industries', postingOrgName: '   '),
        ),
        'Kalyani Industries',
      );
    });

    test('signed out is an empty label, never a crash', () {
      expect(postingOrgLabelFor(null), '');
    });
  });

  group('PayerMe parses the additive field', () {
    test('present', () {
      final PayerMe me = PayerMe.fromJson(<String, dynamic>{
        'id': 'p-1',
        'role': 'agent',
        'status': 'active',
        'orgName': 'Ravi Staffing',
        'email': 'a@b.in',
        'phoneLast4': '3210',
        'postingOrgName': 'Sunrise Agency',
      });
      expect(me.postingOrgName, 'Sunrise Agency');
    });

    test('absent on an older API, and null when tenancy refuses', () {
      final PayerMe older = PayerMe.fromJson(<String, dynamic>{
        'id': 'p-1',
        'role': 'employer',
        'status': 'active',
        'orgName': 'Kalyani Industries',
        'email': 'a@b.in',
        'phoneLast4': '3210',
      });
      expect(older.postingOrgName, isNull);

      final PayerMe denied = PayerMe.fromJson(<String, dynamic>{
        'id': 'p-1',
        'role': 'employer',
        'status': 'active',
        'orgName': 'Kalyani Industries',
        'email': 'a@b.in',
        'phoneLast4': '3210',
        'postingOrgName': null,
      });
      expect(denied.postingOrgName, isNull);
    });
  });
}
