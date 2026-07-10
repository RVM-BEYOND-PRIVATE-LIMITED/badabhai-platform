import 'package:equatable/equatable.dart';

/// A shareable referral invite: the opaque [code] + the absolute [url] the worker
/// sends to a friend. PII-FREE — the code carries no worker identity.
class InviteLink extends Equatable {
  const InviteLink({required this.code, required this.url});

  final String code;
  final String url;

  @override
  List<Object?> get props => <Object?>[code, url];
}

/// Worker referral-invite boundary (A3). Implementations read the session token
/// (never a widget-supplied id), call POST /invites, and compose the absolute
/// share URL from the server-relative link. Throws a [Failure] on error.
abstract interface class InviteRepository {
  /// Creates an invite (optionally tagged with [campaign]) and returns the code
  /// + absolute share URL.
  Future<InviteLink> createInvite({String? campaign});
}
