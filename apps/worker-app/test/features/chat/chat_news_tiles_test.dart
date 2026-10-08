import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/chat/domain/chat_news_link.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/chat_news_tiles.dart';

/// ── ADR-0054 §3.4 (#2148) — THE "READ MORE" TILES ──────────────────────────
void main() {
  ChatNewsLink link(String title, String host) => ChatNewsLink(
        title: title,
        url: Uri.parse('https://www.$host/story'),
        site: host,
      );

  Future<void> pump(
    WidgetTester tester,
    List<ChatNewsLink> links, {
    Future<bool> Function(Uri)? onOpen,
  }) =>
      tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ChatNewsTiles(links: links, onOpen: onOpen),
        ),
      ));

  testWidgets('one tile per link, showing the headline and the site',
      (WidgetTester tester) async {
    await pump(tester, <ChatNewsLink>[
      link('First headline', 'thehindu.com'),
      link('Second headline', 'indianexpress.com'),
    ]);

    expect(find.text('First headline'), findsOneWidget);
    expect(find.text('thehindu.com'), findsOneWidget);
    expect(find.text('Second headline'), findsOneWidget);
    expect(find.text('indianexpress.com'), findsOneWidget);
    // The affordance says tapping leaves the app, once per tile.
    expect(find.text(kChatNewsReadMoreLabel), findsNWidgets(2));
    expect(find.byIcon(Icons.open_in_new), findsNWidgets(2));
  });

  testWidgets('no links draws NOTHING — not an empty frame',
      (WidgetTester tester) async {
    await pump(tester, const <ChatNewsLink>[]);
    expect(find.text(kChatNewsReadMoreLabel), findsNothing);
    expect(find.byType(InkWell), findsNothing);
  });

  testWidgets('tapping a tile opens THAT tile\'s url', (WidgetTester tester) async {
    final List<Uri> opened = <Uri>[];
    await pump(
      tester,
      <ChatNewsLink>[
        link('First headline', 'thehindu.com'),
        link('Second headline', 'indianexpress.com'),
      ],
      onOpen: (Uri url) async {
        opened.add(url);
        return true;
      },
    );

    await tester.tap(find.text('Second headline'));
    await tester.pumpAndSettle();

    expect(opened, hasLength(1));
    expect(opened.single.toString(), 'https://www.indianexpress.com/story');
  });

  testWidgets('every tile meets the 48px tap target', (WidgetTester tester) async {
    await pump(tester, <ChatNewsLink>[link('A headline', 'thehindu.com')]);
    expect(
      tester.getSize(find.byType(InkWell).first).height,
      greaterThanOrEqualTo(48),
    );
  });

  testWidgets('a screen reader hears the headline, the site and the affordance',
      (WidgetTester tester) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    await pump(tester, <ChatNewsLink>[link('A headline', 'thehindu.com')]);

    // Where it leads has to be in the label: the line below is invisible to a
    // reader deciding whether to leave the app.
    expect(
      find.bySemanticsLabel(
        'A headline — thehindu.com, $kChatNewsReadMoreLabel',
      ),
      findsOneWidget,
    );
    handle.dispose();
  });

  testWidgets('a long headline is clamped, never overflowing the bubble',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await pump(tester, <ChatNewsLink>[
      link('A headline that runs on and on and on well past any sane width for '
          'a small handset at a large system font', 'thehindu.com'),
    ]);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });
}
