import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../domain/invite_repository.dart';

/// Hands invite text to the platform share sheet. Injected so tests never touch
/// the native share plugin.
typedef ShareFn = Future<void> Function(String text);

/// Opens a URL in an external app. Returns false when nothing could handle it.
/// Injected for the same reason as [ShareFn] — `flutter test` has no plugins.
typedef LaunchUrlFn = Future<bool> Function(Uri url);

/// Writes text to the system clipboard. Injected so the widget test does not
/// have to stand up the real platform channel.
typedef CopyFn = Future<void> Function(String text);

Future<void> _defaultShare(String text) => Share.share(text);

Future<bool> _defaultLaunch(Uri url) =>
    launchUrl(url, mode: LaunchMode.externalApplication);

Future<void> _defaultCopy(String text) =>
    Clipboard.setData(ClipboardData(text: text));

/// The WhatsApp share hand-off for [text].
///
/// `https://wa.me/?text=…` with NO phone number opens WhatsApp on the CONTACT
/// PICKER with the message pre-filled — which is exactly the invite flow: the
/// worker chooses who to send it to. A number in the path would instead open a
/// chat with that number, which is not what "share my referral link" means.
///
/// The `https://` form rather than `whatsapp://`: the https link degrades to a
/// web page that offers to open WhatsApp when the app is absent, whereas the
/// custom scheme simply fails to resolve. One URL, no dead end — the same
/// reasoning the `/r/<code>` resolver follows on the backend.
///
/// NO PII: the text is the Hinglish blurb plus the opaque invite link. No name,
/// no phone, no worker id — the worker's own identity is not in the message.
Uri whatsAppShareUri(String text) =>
    Uri.parse('https://wa.me/?text=${Uri.encodeComponent(text)}');

enum InviteStatus { loading, ready, error }

class InviteState extends Equatable {
  const InviteState({
    this.status = InviteStatus.loading,
    this.link,
    this.failure,
  });

  final InviteStatus status;
  final InviteLink? link;
  final Failure? failure;

  InviteState copyWith({InviteStatus? status, InviteLink? link, Failure? failure}) =>
      InviteState(
        status: status ?? this.status,
        link: link ?? this.link,
        failure: failure ?? this.failure,
      );

  @override
  List<Object?> get props => <Object?>[status, link, failure];
}

/// Creates a referral invite on open and shares it via the platform sheet (A3).
class InviteCubit extends Cubit<InviteState> {
  InviteCubit(
    this._repo, {
    ShareFn? share,
    LaunchUrlFn? launch,
    CopyFn? copy,
  })  : _share = share ?? _defaultShare,
        _launch = launch ?? _defaultLaunch,
        _copy = copy ?? _defaultCopy,
        super(const InviteState());

  final InviteRepository _repo;
  final ShareFn _share;
  final LaunchUrlFn _launch;
  final CopyFn _copy;

  /// The Hinglish message wrapped around the invite link when sharing.
  ///
  /// PERSONA: the imperatives were tum-form ('banao', 'pao', 'shuru karo').
  /// The Ten Laws are always-aap, and this line is read by the INVITED worker —
  /// it is the first thing BadaBhai ever says to them, so it must not be the one
  /// place the app slips into tum. Same meaning, aap-form endings.
  String shareText(InviteLink link) =>
      'BadaBhai par apna profile banaiye aur factory jobs paiye — bina test, bas '
      'baat-cheet se. Yahan se shuru kariye: ${link.url}';

  Future<void> load() async {
    emit(const InviteState(status: InviteStatus.loading));
    try {
      final InviteLink link = await _repo.createInvite();
      if (isClosed) return;
      emit(InviteState(status: InviteStatus.ready, link: link));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(InviteState(status: InviteStatus.error, failure: f));
    }
  }

  /// Opens the share sheet with the current invite link. No-op until loaded.
  Future<void> shareInvite() async {
    final InviteLink? link = state.link;
    if (link == null) return;
    await _share(shareText(link));
    // B7 funnel milestone. Deliberately NO parameters: the invite code and the
    // link are the only things this method knows, and neither may leave the
    // device in a telemetry event. The OS also does not report which app the
    // worker picked, so a "channel" field would be invented data.
    unawaited(BbAnalytics.instance.log(BbAnalytics.inviteShared));
  }

  /// Opens WhatsApp directly with the invite pre-filled. No-op until loaded.
  ///
  /// FALLS BACK TO THE SHARE SHEET rather than failing. A worker without
  /// WhatsApp installed (or on an OEM build that refuses the intent) tapped a
  /// button labelled "WhatsApp pe bhejein" and must still end up able to send
  /// the link — a dead button on the one screen whose whole purpose is sharing
  /// is worse than landing one step wider. `launchUrl` both returns false and
  /// throws depending on the platform channel's mood, so both are handled.
  Future<void> shareInviteOnWhatsApp() async {
    final InviteLink? link = state.link;
    if (link == null) return;
    final String text = shareText(link);

    bool opened = false;
    try {
      opened = await _launch(whatsAppShareUri(text));
    } catch (_) {
      opened = false;
    }
    if (!opened) await _share(text);

    // The SAME milestone as the sheet path, for the same reason: we do not know
    // (and must not claim to know) which app actually received the text. Adding
    // a `channel: whatsapp` here would be invented data on the fallback path.
    unawaited(BbAnalytics.instance.log(BbAnalytics.inviteShared));
  }

  /// Copies the raw invite URL to the clipboard. No-op until loaded.
  ///
  /// The LINK ONLY, not [shareText] — a worker who taps copy is pasting into a
  /// message they are already writing, and a paragraph of our copy dropped into
  /// the middle of their sentence is not what they asked for.
  Future<bool> copyInviteLink() async {
    final InviteLink? link = state.link;
    if (link == null) return false;
    try {
      await _copy(link.url);
      return true;
    } catch (_) {
      // Clipboard access can be refused. Report it so the UI can stay honest
      // rather than claiming "Copied!" over a clipboard that is unchanged.
      return false;
    }
  }
}
