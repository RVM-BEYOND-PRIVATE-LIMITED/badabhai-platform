import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/util/read_order.dart';

/// #2592 — overlapping reads of one list: the one SENT later wins.
void main() {
  test('a response older than the one on screen is dropped', () {
    final ReadOrder reads = ReadOrder();
    final int first = reads.start();
    final int second = reads.start();

    expect(reads.claim(second), isTrue);
    expect(reads.claim(first), isFalse, reason: 'it would put older data back');
  });

  test('an older response still lands when nothing newer has', () {
    final ReadOrder reads = ReadOrder();
    final int first = reads.start();
    final int second = reads.start();

    // The newer read failed: nothing newer than [first] is on screen.
    expect(reads.isLatest(second), isTrue);
    expect(reads.claim(first), isTrue);
    expect(reads.claim(first), isFalse, reason: 'a ticket lands once');
  });

  test('only the newest read reports its failure', () {
    final ReadOrder reads = ReadOrder();
    final int first = reads.start();
    expect(reads.isLatest(first), isTrue);
    reads.start();
    expect(reads.isLatest(first), isFalse);
  });

  test('a failure on screen drops every read started before it', () {
    final ReadOrder reads = ReadOrder();
    expect(reads.claim(reads.start()), isTrue);
    final int older = reads.start(); // a slow refresh
    final int failed = reads.start(); // the re-read after an action
    expect(reads.isLatest(failed), isTrue);

    reads.settle(failed);

    expect(reads.claim(older), isFalse,
        reason: 'it would repaint the list from before the action');
    expect(reads.claim(reads.start()), isTrue,
        reason: 'a read started after the failure still lands');
  });
}
