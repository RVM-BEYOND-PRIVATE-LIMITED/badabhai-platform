import '../../../core/api/api_client.dart';
import '../../../core/config/app_config.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/invite_repository.dart';

/// Creates referral invites via [ApiClient.createInvite] using the session token
/// (never a widget-supplied id) and composes the absolute share URL by prefixing
/// [kInviteLinkBase] onto the server-relative `link`. Transport errors map to the
/// shared [Failure] hierarchy via [mapError].
class InviteRepositoryImpl implements InviteRepository {
  InviteRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<InviteLink> createInvite({String? campaign}) async {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    try {
      final InviteResult result =
          await _api.createInvite(authToken: token, campaign: campaign);
      return InviteLink(code: result.code, url: _absolute(result.link));
    } catch (error) {
      throw mapError(error);
    }
  }

  /// `https://app.badabhai.in` + `/i/<code>`. Tolerates an already-absolute link
  /// and a base/link slash overlap.
  String _absolute(String link) {
    if (link.startsWith('http://') || link.startsWith('https://')) return link;
    final String base =
        kInviteLinkBase.endsWith('/') ? kInviteLinkBase.substring(0, kInviteLinkBase.length - 1) : kInviteLinkBase;
    final String path = link.startsWith('/') ? link : '/$link';
    return '$base$path';
  }
}
