import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_news_link.dart';

/// ── ADR-0054 §3.4 (#2148) — THE NEWS TILES' WIRE ───────────────────────────
///
/// `news_links` is additive, 1–3 items, ABSENT on every turn but an answered
/// news one and never null. Every url is `https` on an owner-approved site and
/// the backend has already checked it — the client re-checks anyway, because a
/// tile is a tap straight out of the app.
void main() {
  Map<String, dynamic> link({
    Object? title = 'Article headline',
    Object? url = 'https://www.thehindu.com/news/story',
    Object? site = 'thehindu.com',
  }) =>
      <String, dynamic>{'title': title, 'url': url, 'site': site};

  group('ChatNewsLink.fromJson', () {
    test('reads a well-formed https link', () {
      final ChatNewsLink? parsed = ChatNewsLink.fromJson(link());
      expect(parsed, isNotNull);
      expect(parsed!.title, 'Article headline');
      expect(parsed.site, 'thehindu.com');
      expect(parsed.url.toString(), 'https://www.thehindu.com/news/story');
    });

    test('trims the text fields', () {
      final ChatNewsLink? parsed = ChatNewsLink.fromJson(
        link(title: '  Headline  ', site: '  thehindu.com  '),
      );
      expect(parsed!.title, 'Headline');
      expect(parsed.site, 'thehindu.com');
    });

    test('REFUSES anything that is not https', () {
      // The issue is explicit: do not render a tile whose url is not https.
      for (final String bad in <String>[
        'http://www.thehindu.com/x',
        'ftp://thehindu.com/x',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'thehindu.com/x',
      ]) {
        expect(ChatNewsLink.fromJson(link(url: bad)), isNull, reason: bad);
      }
    });

    test('refuses a missing or blank field rather than drawing a gap', () {
      expect(ChatNewsLink.fromJson(link(title: '')), isNull);
      expect(ChatNewsLink.fromJson(link(title: '   ')), isNull);
      expect(ChatNewsLink.fromJson(link(site: '')), isNull);
      expect(ChatNewsLink.fromJson(link(url: '')), isNull);
      expect(ChatNewsLink.fromJson(link(title: null)), isNull);
      expect(ChatNewsLink.fromJson(link(url: null)), isNull);
      expect(ChatNewsLink.fromJson(link(site: null)), isNull);
    });

    test('refuses a non-map and non-string fields', () {
      expect(ChatNewsLink.fromJson(null), isNull);
      expect(ChatNewsLink.fromJson('a string'), isNull);
      expect(ChatNewsLink.fromJson(7), isNull);
      expect(ChatNewsLink.fromJson(link(title: 7)), isNull);
      expect(ChatNewsLink.fromJson(link(url: <String>['x'])), isNull);
    });
  });

  group('ChatNewsLink.listFromJson', () {
    test('keeps served order', () {
      final List<ChatNewsLink> links = ChatNewsLink.listFromJson(<Object?>[
        link(title: 'One'),
        link(title: 'Two'),
        link(title: 'Three'),
      ]);
      expect(links.map((ChatNewsLink l) => l.title), <String>['One', 'Two', 'Three']);
    });

    test('drops only the unusable item, keeping the rest', () {
      final List<ChatNewsLink> links = ChatNewsLink.listFromJson(<Object?>[
        link(title: 'Good'),
        link(url: 'http://insecure.example/x'),
        null,
        link(title: 'Also good'),
      ]);
      expect(links.map((ChatNewsLink l) => l.title), <String>['Good', 'Also good']);
    });

    test('absent, null and non-list all read as EMPTY', () {
      // "This turn has no tiles" is one thing however the wire says it.
      expect(ChatNewsLink.listFromJson(null), isEmpty);
      expect(ChatNewsLink.listFromJson(<Object?>[]), isEmpty);
      expect(ChatNewsLink.listFromJson('nope'), isEmpty);
      expect(ChatNewsLink.listFromJson(<Object?>[null, 7]), isEmpty);
    });
  });

  group('the chat reply carries them', () {
    test('an answered news turn', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aaj ki badi khabar...',
        'read_aloud': false,
        'news_links': <Object?>[link(), link(title: 'Second')],
      });
      expect(reply.newsLinks, hasLength(2));
      // Model-written, so never spoken (#2030 / ADR-0046 O9).
      expect(reply.readAloud, isFalse);
    });

    test('every other turn has none — the key is absent, not null', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Theek hai.',
      });
      expect(reply.newsLinks, isEmpty);
    });
  });

  group('the replay carries them', () {
    test('a bot row redraws its tiles after a restart', () {
      final SessionMessage row = SessionMessage.fromJson(<String, dynamic>{
        'direction': 'outbound',
        'body_text': 'Aaj ki badi khabar...',
        'created_at': '2026-10-08T05:00:00Z',
        'news_links': <Object?>[link()],
      });
      expect(row.newsLinks, hasLength(1));
      expect(row.newsLinks.single.site, 'thehindu.com');
    });

    test('a row without the key replays with none', () {
      final SessionMessage row = SessionMessage.fromJson(<String, dynamic>{
        'direction': 'outbound',
        'body_text': 'Theek hai.',
        'created_at': '2026-10-08T05:00:00Z',
      });
      expect(row.newsLinks, isEmpty);
    });
  });
}
