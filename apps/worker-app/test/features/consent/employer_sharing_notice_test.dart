// The employer-sharing notice must render the APPROVED copy verbatim — same
// words, same bold spans (docs/product/employer-sharing-consent-notice.md,
// approved 2026-11-04). This test reads the doc itself, so the widget cannot
// drift from it silently: a wording change must land in both, with
// kConsentVersion bumped (which is what runs this gate).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/presentation/widgets/employer_sharing_notice.dart';

/// One rendered (or approved) block: its plain text and its bold runs.
class _Block {
  _Block(this.text, this.bold);

  final String text;
  final List<String> bold;

  @override
  String toString() => '"$text" bold=$bold';
}

const String _docPath = '../../docs/product/employer-sharing-consent-notice.md';

/// The doc's "### Heading" quote, and its "### Body" quote split into blocks
/// (paragraphs and bullet items, wrapped lines joined with one space).
({String heading, List<_Block> body}) _approvedCopy() {
  final String doc = File(_docPath).readAsStringSync().replaceAll('\r\n', '\n');
  String section(String start, String end) {
    final int from = doc.indexOf(start);
    final int to = doc.indexOf(end, from);
    expect(from, isNonNegative, reason: 'doc lost its "$start" section');
    expect(to, greaterThan(from), reason: 'doc lost its "$end" section');
    return doc.substring(from + start.length, to);
  }

  List<String> quoteLines(String s) => s
      .split('\n')
      .where((String l) => l.startsWith('>'))
      .map((String l) => l.length > 1 ? l.substring(2) : '')
      .toList();

  final String heading =
      quoteLines(section('### Heading', '### Body')).join(' ').trim();

  final List<String> raw = <String>[];
  for (final String line in quoteLines(section('### Body', '### Prompt'))) {
    if (line.trim().isEmpty) {
      raw.add('');
    } else if (line.startsWith('- ')) {
      raw
        ..add('')
        ..add(line.substring(2));
    } else if (raw.isNotEmpty && raw.last.isNotEmpty) {
      raw[raw.length - 1] = '${raw.last} ${line.trim()}';
    } else {
      raw.add(line.trim());
    }
  }
  final List<_Block> body = <_Block>[];
  for (final String md in raw.where((String b) => b.isNotEmpty)) {
    final List<String> parts = md.split('**');
    body.add(_Block(
      parts.join(),
      <String>[for (int i = 1; i < parts.length; i += 2) parts[i].trim()],
    ));
  }
  return (heading: heading, body: body);
}

/// Every RichText under the notice, in paint order, with the runs whose
/// EFFECTIVE weight is bold (inherited down the span tree).
List<_Block> _renderedBlocks(WidgetTester tester) {
  final Iterable<RichText> texts = tester.widgetList<RichText>(
    find.descendant(
      of: find.byType(EmployerSharingNotice),
      matching: find.byType(RichText),
    ),
  );
  return <_Block>[
    for (final RichText rt in texts) _blockOf(rt.text),
  ];
}

_Block _blockOf(InlineSpan root) {
  final StringBuffer text = StringBuffer();
  final List<String> bold = <String>[];
  void walk(InlineSpan span, FontWeight inherited) {
    final FontWeight weight = span.style?.fontWeight ?? inherited;
    if (span is TextSpan) {
      final String own = span.text ?? '';
      text.write(own);
      if (own.trim().isNotEmpty && weight.value >= FontWeight.w700.value) {
        bold.add(own.trim());
      }
      for (final InlineSpan child in span.children ?? const <InlineSpan>[]) {
        walk(child, weight);
      }
    }
  }

  walk(root, FontWeight.w400);
  return _Block(text.toString(), bold);
}

void main() {
  late ({String heading, List<_Block> body}) approved;

  setUpAll(() => approved = _approvedCopy());

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: const Scaffold(
          body: SingleChildScrollView(child: EmployerSharingNotice()),
        ),
      ),
    );
  }

  test('the doc parses into the approved heading and nine body blocks', () {
    // Guards the parser itself: a parse that returned nothing would make the
    // parity test below vacuous.
    expect(approved.heading, 'Companies aapki profile dekh sakti hain');
    expect(approved.body, hasLength(9));
    expect(
      approved.body.expand((_Block b) => b.bold),
      <String>[
        'naam, phone number aur photo',
        'unlock',
        'resume',
        'phone number',
        'BadaBhai ke andar message',
        'Dhyaan dein:',
        'Settings',
      ],
    );
  });

  testWidgets('renders the approved copy verbatim, block by block', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    final List<_Block> rendered = _renderedBlocks(tester);

    expect(rendered.first.text, approved.heading);
    final List<_Block> body = rendered.skip(1).toList();
    expect(body.map((_Block b) => b.text).toList(),
        approved.body.map((_Block b) => b.text).toList());
  });

  testWidgets('bolds exactly the spans the doc bolds — nothing more', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    final List<_Block> body = _renderedBlocks(tester).skip(1).toList();

    expect(body.map((_Block b) => b.bold).toList(),
        approved.body.map((_Block b) => b.bold).toList());
  });
}
