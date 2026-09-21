import 'inbox_models.dart';

/// The in-app relay's worker side (E0, FE #1628).
///
/// Contract: `apps/api/src/relay/worker-relay.controller.ts`. Every read/write
/// re-checks the server's fail-closed ladder at use time — a withdrawn
/// employer-messaging consent closes these paths too.
abstract interface class InboxRepository {
  /// The caller's own threads, newest activity first (faceless).
  Future<List<InboxThread>> threads();

  /// One thread's messages, oldest first — or `null` when the server serves its
  /// ONE neutral body (expired / foreign / consent withdrawn, deliberately
  /// indistinguishable). The caller states the thread is closed, never guesses
  /// which of those it was.
  Future<List<InboxMessage>?> thread(String unlockId);

  /// Sends the worker's free-text reply. `false` when the server served the
  /// neutral body (the thread closed under the caller) — never a reason.
  Future<bool> reply(String unlockId, String text);

  /// Marks the thread's inbound messages read (audit only). Best-effort.
  Future<void> markRead(String unlockId);
}
