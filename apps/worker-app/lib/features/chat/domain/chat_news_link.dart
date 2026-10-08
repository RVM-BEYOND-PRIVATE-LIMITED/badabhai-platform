import 'package:equatable/equatable.dart';

/// ADR-0054 §3.4 — one "read more" tile under a free-chat NEWS answer.
///
/// The server sends 1–3 of these on an answered news turn and the key is ABSENT
/// on every other turn (never null). The summary itself is the bot's ordinary
/// model-written lines; these are the sources it was written from.
///
/// THE CLIENT RE-CHECKS THE SCHEME ANYWAY. The backend only ever sends `https`
/// urls on the owner-approved list and has already validated them — but a tile
/// is a tap straight out of the app into a browser, so this parse refuses
/// anything that is not `https` rather than trusting that guarantee held. A
/// refused link is DROPPED, never rendered disabled: a tile a worker cannot use
/// is worse than one that was never drawn.
class ChatNewsLink extends Equatable {
  const ChatNewsLink({
    required this.title,
    required this.url,
    required this.site,
  });

  /// The article headline, as the source published it.
  final String title;

  /// An `https` url on the approved list. Opened in the external browser.
  final Uri url;

  /// The publisher's host ("thehindu.com") — shown so a worker can see where a
  /// tile leads before tapping it.
  final String site;

  /// Parses one wire item, or null when it cannot safely become a tile.
  ///
  /// Null on: a non-map, a missing/blank title or site, a missing/unparsable
  /// url, or any scheme but `https`. Each is a reason the tile could not be
  /// drawn honestly, so none of them throws — the turn still shows its summary.
  static ChatNewsLink? fromJson(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final Object? title = raw['title'];
    final Object? url = raw['url'];
    final Object? site = raw['site'];
    if (title is! String || title.trim().isEmpty) return null;
    if (site is! String || site.trim().isEmpty) return null;
    if (url is! String || url.trim().isEmpty) return null;
    final Uri? parsed = Uri.tryParse(url.trim());
    if (parsed == null || parsed.scheme != 'https' || !parsed.hasAuthority) {
      return null;
    }
    return ChatNewsLink(
      title: title.trim(),
      url: parsed,
      site: site.trim(),
    );
  }

  /// Every tile a turn carries, in served order. An absent key, a null, a
  /// non-list or a list of unusable items all come back EMPTY — "this turn has
  /// no tiles" is the same thing however the wire says it.
  static List<ChatNewsLink> listFromJson(Object? raw) {
    if (raw is! List) return const <ChatNewsLink>[];
    return <ChatNewsLink>[
      for (final Object? item in raw)
        if (ChatNewsLink.fromJson(item) case final ChatNewsLink link) link,
    ];
  }

  @override
  List<Object?> get props => <Object?>[title, url, site];
}
