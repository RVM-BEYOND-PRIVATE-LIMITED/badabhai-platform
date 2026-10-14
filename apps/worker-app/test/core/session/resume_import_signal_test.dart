import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/session/resume_import_signal.dart';

/// The signal that tells the chat "a résumé upload just completed, and you have
/// not acted on it yet" — the thing the route `extra` could not carry, because
/// it rides `cameFromImport`, which is FALSE on three outcome branches.
void main() {
  test('nothing pending reads false', () {
    expect(ResumeImportSignal().consume(), isFalse);
  });

  test('a completed upload is readable exactly ONCE', () {
    final ResumeImportSignal s = ResumeImportSignal()..markCompleted();
    expect(s.consume(), isTrue);
    // A rebuild, a tab refocus or a second listener pass must not answer the
    // prompt a second time.
    expect(s.consume(), isFalse);
    expect(s.consume(), isFalse);
  });

  test('two uploads are two signals', () {
    final ResumeImportSignal s = ResumeImportSignal()..markCompleted();
    expect(s.consume(), isTrue);
    s.markCompleted();
    expect(s.consume(), isTrue);
  });

  test('marking twice before a read still yields one', () {
    final ResumeImportSignal s = ResumeImportSignal()
      ..markCompleted()
      ..markCompleted();
    expect(s.consume(), isTrue);
    expect(s.consume(), isFalse);
  });

  test('clear drops a pending signal — the shared-phone rule', () {
    // On logout the next worker must not have a prompt answered for them.
    final ResumeImportSignal s = ResumeImportSignal()..markCompleted();
    s.clear();
    expect(s.consume(), isFalse);
  });
}
