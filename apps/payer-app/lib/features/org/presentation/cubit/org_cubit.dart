import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the signed-in payer's org/team (`GET /payer/org/members`) and drives
/// the owner-only invite/remove + the self-serve accept-invite actions. Owner
/// gating is DERIVED from the members list (the [OrgState.self] row's role), so
/// the UI hides owner-only affordances for a recruiter session; the server also
/// 403s, and a stray 403/409 becomes an HONEST neutral message, never a crash.
class OrgCubit extends Cubit<OrgState> {
  OrgCubit(this._api) : super(const OrgState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: OrgStatus.loading));
    try {
      final List<OrgMemberView> members = await _api.fetchOrgMembers();
      emit(OrgState(status: OrgStatus.ready, members: members));
    } catch (_) {
      emit(state.copyWith(
        status: OrgStatus.error,
        error: 'Could not load your team. Retry in a moment.',
      ));
    }
  }

  /// Invite a recruiter (OWNER-only server-side). [email] is handed straight to
  /// the POST and never held here; the list refetches so the invited row shows.
  Future<OrgActionResult> invite(String email) async {
    try {
      await _api.inviteOrgMember(email: email);
      await load();
      return const OrgActionResult.ok("Invite sent — they'll get an email to join.");
    } on PayerApiException catch (e) {
      return OrgActionResult.fail(switch (e.statusCode) {
        409 => 'Already on your team, or your team is full.',
        503 => "Couldn't send the invite email. Try again in a bit.",
        403 => 'Only the org owner can invite teammates.',
        _ => "Couldn't send the invite right now.",
      });
    } catch (_) {
      return OrgActionResult.fail('Network error. Check your connection.');
    }
  }

  /// Remove a teammate (OWNER-only). A 409 (the target is the owner) / 403 (not
  /// the owner) surface honestly.
  Future<OrgActionResult> remove(String memberId) async {
    try {
      await _api.removeOrgMember(memberId);
      await load();
      return const OrgActionResult.ok('Removed from your team.');
    } on PayerApiException catch (e) {
      return OrgActionResult.fail(switch (e.statusCode) {
        409 => "You can't remove the org owner.",
        403 => 'Only the org owner can remove teammates.',
        _ => "Couldn't remove them right now.",
      });
    } catch (_) {
      return OrgActionResult.fail('Network error. Check your connection.');
    }
  }

  /// Accept a teammate invite with the single-use [token] from the accept link.
  /// 404 (bad/expired token) / 403 (email mismatch) surface honestly.
  Future<OrgActionResult> acceptInvite(String token) async {
    try {
      await _api.acceptOrgInvite(token: token);
      await load();
      return const OrgActionResult.ok('Invite accepted — welcome to the team.');
    } on PayerApiException catch (e) {
      return OrgActionResult.fail(switch (e.statusCode) {
        404 => 'That invite link is invalid or has expired.',
        403 => 'This invite was sent to a different email.',
        _ => "Couldn't accept the invite right now.",
      });
    } catch (_) {
      return OrgActionResult.fail('Network error. Check your connection.');
    }
  }
}

/// The outcome of a one-shot Team action — a success/neutral flag + a human
/// message the screen shows as a toast. Never carries PII.
class OrgActionResult {
  const OrgActionResult.ok(this.message) : success = true;
  const OrgActionResult.fail(this.message) : success = false;

  final bool success;
  final String message;
}

enum OrgStatus { initial, loading, ready, error }

class OrgState extends Equatable {
  const OrgState({
    this.status = OrgStatus.initial,
    this.members = const <OrgMemberView>[],
    this.error,
  });

  final OrgStatus status;
  final List<OrgMemberView> members;
  final String? error;

  /// The current session's own member row (drives the "You" tag + owner gate).
  OrgMemberView? get self {
    for (final OrgMemberView m in members) {
      if (m.isSelf) return m;
    }
    return null;
  }

  /// True only when the signed-in session is the org OWNER — the sole principal
  /// allowed to invite/remove. Owner-only affordances are hidden otherwise.
  bool get isOwner => self?.isOwner ?? false;

  OrgState copyWith({
    OrgStatus? status,
    List<OrgMemberView>? members,
    String? error,
  }) {
    return OrgState(
      status: status ?? this.status,
      members: members ?? this.members,
      error: error,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, members, error];
}
