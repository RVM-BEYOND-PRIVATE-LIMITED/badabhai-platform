import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/org/presentation/cubit/org_cubit.dart';

/// #366 — the payer presentation layer was untested while all coverage sat at
/// the HTTP client seam, so a cubit-level regression (a 409 seat-cap rendered
/// as success, or the owner gate derived from the wrong row) would ship green.
/// These lock OrgCubit's two load-bearing behaviours: the DERIVED owner gate,
/// and the status-code → honest-message mapping on every write action.
class _ScriptedOrgApi extends MockPayerApiClient {
  List<OrgMemberView> members = const <OrgMemberView>[];

  Object? throwOnFetch;
  Object? throwOnInvite;
  Object? throwOnRemove;
  Object? throwOnAccept;

  int fetches = 0;
  final List<String> invitedEmails = <String>[];
  final List<String> removedIds = <String>[];
  final List<String> acceptedTokens = <String>[];

  @override
  Future<List<OrgMemberView>> fetchOrgMembers() async {
    fetches++;
    if (throwOnFetch != null) throw throwOnFetch!;
    return members;
  }

  @override
  Future<OrgMemberView> inviteOrgMember({
    required String email,
    String orgRole = 'recruiter',
  }) async {
    invitedEmails.add(email);
    if (throwOnInvite != null) throw throwOnInvite!;
    final OrgMemberView invited = OrgMemberView(
      memberId: 'm-new',
      orgRole: orgRole,
      status: 'invited',
      emailMasked: 'n•••@acme.in',
    );
    members = <OrgMemberView>[...members, invited];
    return invited;
  }

  @override
  Future<void> removeOrgMember(String memberId) async {
    removedIds.add(memberId);
    if (throwOnRemove != null) throw throwOnRemove!;
    members = members
        .where((OrgMemberView m) => m.memberId != memberId)
        .toList(growable: false);
  }

  @override
  Future<OrgMemberView> acceptOrgInvite({required String token}) async {
    acceptedTokens.add(token);
    if (throwOnAccept != null) throw throwOnAccept!;
    return const OrgMemberView(
      memberId: 'm-self',
      orgRole: 'recruiter',
      status: 'active',
      emailMasked: 'y•••@acme.in',
      isSelf: true,
    );
  }
}

OrgMemberView _member(
  String id, {
  String role = 'recruiter',
  String status = 'active',
  bool isSelf = false,
}) =>
    OrgMemberView(
      memberId: id,
      orgRole: role,
      status: status,
      emailMasked: '$id•••@acme.in',
      isSelf: isSelf,
    );

void main() {
  late _ScriptedOrgApi api;
  late OrgCubit cubit;

  setUp(() {
    api = _ScriptedOrgApi();
    cubit = OrgCubit(api);
  });

  tearDown(() => cubit.close());

  group('load + the derived owner gate', () {
    test('ready with the members list', () async {
      api.members = <OrgMemberView>[
        _member('a', role: 'owner', isSelf: true),
        _member('b'),
      ];

      await cubit.load();

      expect(cubit.state.status, OrgStatus.ready);
      expect(cubit.state.members.length, 2);
      expect(cubit.state.error, isNull);
    });

    test('isOwner comes from the SELF row, not from any owner in the list',
        () async {
      // A recruiter session sees the owner's row too — gating on "the list
      // contains an owner" would hand a recruiter the invite/remove buttons.
      api.members = <OrgMemberView>[
        _member('a', role: 'owner'),
        _member('b', isSelf: true),
      ];

      await cubit.load();

      expect(cubit.state.self?.memberId, 'b');
      expect(cubit.state.isOwner, isFalse);
    });

    test('isOwner is true only when the self row IS the owner', () async {
      api.members = <OrgMemberView>[
        _member('a', role: 'owner', isSelf: true),
        _member('b'),
      ];

      await cubit.load();

      expect(cubit.state.isOwner, isTrue);
    });

    test('no self row at all → not owner (fail closed)', () async {
      api.members = <OrgMemberView>[_member('a', role: 'owner')];

      await cubit.load();

      expect(cubit.state.self, isNull);
      expect(cubit.state.isOwner, isFalse);
    });

    test('a failed load is an honest error state, not an empty team', () async {
      api.throwOnFetch = const PayerApiException(503);

      await cubit.load();

      expect(cubit.state.status, OrgStatus.error);
      expect(cubit.state.error, isNotNull);
      expect(cubit.state.status, isNot(OrgStatus.ready));
    });
  });

  group('invite', () {
    setUp(() async {
      api.members = <OrgMemberView>[_member('a', role: 'owner', isSelf: true)];
      // Start from a loaded team so "did NOT refetch" / "state unchanged"
      // assertions below are about real state, not an empty initial one.
      await cubit.load();
      api.fetches = 0;
    });

    test('success refetches so the invited row appears', () async {
      final OrgActionResult result = await cubit.invite('ravi.kumar@acme.in');

      expect(result.success, isTrue);
      expect(api.fetches, 1, reason: 'the list must refetch after an invite');
      expect(cubit.state.members.length, 2);
      expect(cubit.state.status, OrgStatus.ready);
    });

    test('the raw invitee email is handed to the POST and never held in state',
        () async {
      await cubit.invite('ravi.kumar@acme.in');

      expect(api.invitedEmails, <String>['ravi.kumar@acme.in']);
      // CLAUDE.md §2 — the only identity ever kept is the server mask.
      for (final OrgMemberView m in cubit.state.members) {
        expect(m.emailMasked.contains('ravi.kumar'), isFalse);
      }
    });

    test('409 (already a member / seat cap) is a FAILURE, never success',
        () async {
      api.throwOnInvite = const PayerApiException(409);

      final OrgActionResult result = await cubit.invite('ravi@acme.in');

      // The exact failure scenario in #366: a 409 seat cap rendered as success
      // shows the owner a phantom teammate who was never invited.
      expect(result.success, isFalse);
      expect(result.message, 'Already on your team, or your team is full.');
      expect(api.fetches, 0, reason: 'a failed invite must not refetch');
      expect(cubit.state.members.map((OrgMemberView m) => m.memberId),
          <String>['a'],
          reason: 'state must not change on a rejected invite');
    });

    test('503 (mailer down) says the email failed, not that the seat is taken',
        () async {
      api.throwOnInvite = const PayerApiException(503);

      final OrgActionResult result = await cubit.invite('ravi@acme.in');

      expect(result.success, isFalse);
      expect(result.message, "Couldn't send the invite email. Try again in a bit.");
    });

    test('403 (not the owner) surfaces the permission reason', () async {
      api.throwOnInvite = const PayerApiException(403);

      final OrgActionResult result = await cubit.invite('ravi@acme.in');

      expect(result.success, isFalse);
      expect(result.message, 'Only the org owner can invite teammates.');
    });

    test('an unmapped status falls back to a neutral failure', () async {
      api.throwOnInvite = const PayerApiException(500);

      final OrgActionResult result = await cubit.invite('ravi@acme.in');

      expect(result.success, isFalse);
      expect(result.message, "Couldn't send the invite right now.");
    });

    test('a transport error (no status code) is reported as a network error',
        () async {
      api.throwOnInvite = Exception('socket closed');

      final OrgActionResult result = await cubit.invite('ravi@acme.in');

      expect(result.success, isFalse);
      expect(result.message, 'Network error. Check your connection.');
    });
  });

  group('remove', () {
    setUp(() async {
      api.members = <OrgMemberView>[
        _member('a', role: 'owner', isSelf: true),
        _member('b'),
      ];
      await cubit.load();
      api.fetches = 0;
    });

    test('success drops the row and refetches', () async {
      final OrgActionResult result = await cubit.remove('b');

      expect(result.success, isTrue);
      expect(api.removedIds, <String>['b']);
      expect(api.fetches, 1);
      expect(cubit.state.members.map((OrgMemberView m) => m.memberId),
          <String>['a']);
    });

    test('409 (target is the org owner) is a failure with the honest reason',
        () async {
      api.throwOnRemove = const PayerApiException(409);

      final OrgActionResult result = await cubit.remove('a');

      expect(result.success, isFalse);
      expect(result.message, "You can't remove the org owner.");
      expect(api.fetches, 0);
      expect(cubit.state.members.length, 2,
          reason: 'a rejected removal must not drop the row from the UI');
    });

    test('403 (not the owner) is a failure', () async {
      api.throwOnRemove = const PayerApiException(403);

      final OrgActionResult result = await cubit.remove('b');

      expect(result.success, isFalse);
      expect(result.message, 'Only the org owner can remove teammates.');
    });

    test('a 404 (unknown / not-owned) never reads as a successful removal',
        () async {
      api.throwOnRemove = const PayerApiException(404);

      final OrgActionResult result = await cubit.remove('ghost');

      expect(result.success, isFalse);
      expect(result.message, "Couldn't remove them right now.");
    });
  });

  group('acceptInvite', () {
    test('success refetches the team the session just joined', () async {
      api.members = <OrgMemberView>[_member('a', role: 'owner')];

      final OrgActionResult result = await cubit.acceptInvite('tok-1');

      expect(result.success, isTrue);
      expect(api.acceptedTokens, <String>['tok-1']);
      expect(api.fetches, 1);
    });

    test('404 (bad / expired token) is a failure', () async {
      api.throwOnAccept = const PayerApiException(404);

      final OrgActionResult result = await cubit.acceptInvite('tok-dead');

      expect(result.success, isFalse);
      expect(result.message, 'That invite link is invalid or has expired.');
      expect(api.fetches, 0);
    });

    test('403 (invite sent to a different email) is a failure', () async {
      api.throwOnAccept = const PayerApiException(403);

      final OrgActionResult result = await cubit.acceptInvite('tok-1');

      expect(result.success, isFalse);
      expect(result.message, 'This invite was sent to a different email.');
    });
  });
}
