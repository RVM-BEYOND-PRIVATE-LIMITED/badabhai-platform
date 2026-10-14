/// "A résumé upload just completed, and the chat has not acted on it yet."
///
/// WHY THIS EXISTS RATHER THAN A ROUTE `extra`.
///
/// The chat's résumé prompt ("Resume upload karein" / "Mere paas resume nahi
/// hai") is injected by the CLIENT, and the server's real next turn is stashed
/// behind it. The upload screen leaves with `context.go(Routes.chatProfiling)`
/// carrying `kChatFromResumeImport` — but that extra is set from the cubit's
/// `cameFromImport`, which is FALSE on three of the outcome branches (an import
/// that learned nothing, uploads unavailable, and a failed read). On those the
/// chat was never told anything had happened, so it sat on the same question
/// over a résumé the worker had just uploaded.
///
/// `cameFromImport` answers a different question — "should the chat say the
/// one honest line about an import that went quiet" (#1660) — and overloading
/// it to also mean "the door was walked through" is what made this fail on
/// exactly the branches where the import was least satisfying.
///
/// So this signal says only the thing the prompt cares about: the worker went
/// to the upload screen and came back from a COMPLETED attempt. Whether it
/// learned anything is a separate matter, and the server's next turn says it.
///
/// ONE-SHOT: [consume] returns true at most once per upload, so a rebuild, a
/// tab refocus or a second listener pass cannot answer the prompt twice.
class ResumeImportSignal {
  bool _pending = false;

  /// The upload screen finished and is handing back to the chat.
  void markCompleted() => _pending = true;

  /// True exactly once after each [markCompleted].
  bool consume() {
    if (!_pending) return false;
    _pending = false;
    return true;
  }

  /// Drops a pending signal — used on logout, so the next worker on a shared
  /// phone never inherits an answer to a prompt they were never shown.
  void clear() => _pending = false;
}
