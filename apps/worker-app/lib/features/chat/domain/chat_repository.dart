import 'chat_message.dart';
import 'chat_session_opening.dart';
import 'chat_turn.dart';

/// Chat boundary for the profiling conversation. Implementations read the
/// session token / session id from the session (never the widget) and throw a
/// [Failure] on error.
/// What `GET /chat/companion` actually said (#1750).
///
/// THREE ANSWERS, NOT TWO. The old contract returned `ChatTurn?` and collapsed
/// "this worker runs the interview" into the same `null` as "the read did not
/// come back". That cost the main group — form and upload workers — the whole
/// feature on a slow link: the tab fell back to the interview, `ensureSession`
/// minted an EMPTY session, and from then on the server's own policy answered
/// `interview` for six or seven hours because it could see a live session
/// started after the profile was confirmed. An unreachable read must therefore
/// be distinguishable, so the tab can decline to mint anything and retry.
enum CompanionOpenOutcome {
  /// The server says this worker is a companion worker; [CompanionOpening.turn]
  /// is the recap.
  companion,

  /// The server says this worker runs the ordinary interview. A real answer.
  interview,

  /// No answer: timeout, transport error, 5xx, or no session token. NOT a
  /// verdict about the worker — nothing may be minted on it.
  unreachable,
}

/// The result of one companion open.
class CompanionOpening {
  const CompanionOpening(this.outcome, [this.turn]);

  const CompanionOpening.interview() : this(CompanionOpenOutcome.interview);
  const CompanionOpening.unreachable() : this(CompanionOpenOutcome.unreachable);

  final CompanionOpenOutcome outcome;

  /// The recap, present only for [CompanionOpenOutcome.companion].
  final ChatTurn? turn;

  bool get isCompanion =>
      outcome == CompanionOpenOutcome.companion && turn != null;
  bool get isUnreachable => outcome == CompanionOpenOutcome.unreachable;
}

/// What a companion edit confirm/cancel call actually did (ADR-0046 §5.2).
///
/// FOUR ANSWERS, NOT TWO — the same discipline as [CompanionOpenOutcome]. The
/// routes answer `200 turn` (applied / cancelled, or NOTHING written with the
/// card handed back), `404` (the proposal is unknown, expired, or another
/// worker's) and two different 409s: the `{mode:"interview"}` one (this worker
/// is no longer a companion worker) and the `{reason:"stale", turn}` one (the
/// profile changed under the card). Collapsing them would either abandon a live
/// companion on a dead card, keep showing a card the server has already
/// forgotten, or swallow the reviewed line the stale answer carries.
enum CompanionEditOutcome {
  /// The server answered with a turn — the edit was applied, the cancel
  /// acknowledged, or NOTHING was written and the SAME card came back on the
  /// fallback turn. [CompanionEditResult.turn] is that turn.
  served,

  /// The proposal is GONE (404: unknown, expired, another worker's, or already
  /// confirmed): nothing was applied. The tab clears the card and re-reads the
  /// recap — the server's current facts are the only honest thing to show.
  gone,

  /// The profile moved under the card (409 `{reason:"stale"}`): nothing was
  /// applied, and the server carries the reviewed `V2_EDIT_STALE` turn for the
  /// tab to show in place of a line of its own. The card is dead and goes.
  /// [CompanionEditResult.turn] is that turn.
  stale,

  /// The server says this worker is no longer a companion worker (409
  /// `{mode:"interview"}`): the tab leaves companion mode for the interview,
  /// exactly as a 409 on a message send does.
  interview,
}

/// The result of one companion edit confirm/cancel call.
class CompanionEditResult {
  const CompanionEditResult(this.outcome, [this.turn]);

  const CompanionEditResult.served(ChatTurn turn)
      : this(CompanionEditOutcome.served, turn);
  const CompanionEditResult.gone() : this(CompanionEditOutcome.gone);
  const CompanionEditResult.stale(ChatTurn turn)
      : this(CompanionEditOutcome.stale, turn);
  const CompanionEditResult.interview() : this(CompanionEditOutcome.interview);

  final CompanionEditOutcome outcome;

  /// The turn the server served, present for [CompanionEditOutcome.served] and
  /// [CompanionEditOutcome.stale].
  final ChatTurn? turn;
}

abstract interface class ChatRepository {
  /// Ensures a chat session exists (starts one if needed) and stores its id in
  /// the session. No-op when a session is already open.
  ///
  /// Returns the server-served opening when this call actually OPENED a session
  /// and the API supplied one — the ordinary one-shot opener OR the résumé-confirm
  /// first turn (#1523); null otherwise, including on the already-open no-op path
  /// and on the lazy re-open inside [sendMessage], where the worker is
  /// mid-conversation and re-greeting them would be wrong. A null keeps the
  /// client's canned `kChatOpeningText` opener.
  /// The worker's LATEST chat session id, or null when they have none.
  ///
  /// READ-ONLY, and that is the whole point (#1862). [ensureSession] CREATES a
  /// session when none is cached; this only ever looks. The companion's mic
  /// needs a session id to attach a clip to, but must never mint one — a live
  /// session started after confirmation is read by `ChatCompanionPolicy` as
  /// "this worker is interviewing", which would end their companion.
  ///
  /// NEVER THROWS: a failed lookup answers null, and the caller then refuses the
  /// recording honestly rather than falling back to creating one.
  Future<String?> latestSessionId();

  Future<ChatSessionOpening?> ensureSession();

  /// Mint a GENUINELY NEW session, bypassing the `GET /session/latest` resume
  /// (#1566). The post-completion menu's "Chat se resume banayein" must open a
  /// fresh interview, and the resume-first guard in [ensureSession] would
  /// otherwise re-attach to the just-ended session (the server reattaches to a
  /// LIVE session only, but the client never asks). The prior session and its
  /// transcript are preserved server-side; only the cached id is replaced.
  ///
  /// Returns the server-served opening when the new session supplies one (the
  /// one-shot opener), else null — the caller then renders the canned opener,
  /// exactly like an ordinary open.
  Future<ChatSessionOpening?> startNewSession();

  /// Forget the cached interview session id, so the next [ensureSession] asks
  /// the server for the worker's latest session instead of reusing it.
  ///
  /// ADR-0044 — called when the tab leaves the interview for the recap. A tab
  /// that opened ON the recap holds no id, and a later fallback to the
  /// interview reads the latest session; this makes a tab that moved there
  /// from the interview behave the same. Touches nothing server-side.
  void forgetSession();

  /// Sends [text] and returns bada bhai's reply plus any tap-to-answer
  /// [ChatTurn.followups].
  ///
  /// [submissionId] is the per-submission id (#870), forwarded to the wire body
  /// when non-null. Minted once per physical send and re-sent verbatim on a
  /// retry, so the server can tell a retried POST from a worker repeating the
  /// same words. Both callers now supply one — the chat composer (#870) and the
  /// voice-merge path (#944); it stays optional so the contract does not force it.
  Future<ChatTurn> sendMessage(String text, {String? submissionId});

  /// The persisted transcript for the CURRENT session, oldest-first, as
  /// redrawable bubbles (#502 transcript hydration). Empty when there is no open
  /// session or the session has no stored turns yet (a brand-new chat) — the
  /// caller then leaves its opener untouched. BEST-EFFORT: implementations
  /// return `[]` rather than throw, so a hydration miss can never block the chat
  /// from opening.
  Future<List<ChatMessage>> loadHistory();

  /// ADR-0044 — the post-completion COMPANION's opening recap, or null.
  ///
  /// Null means "run today's chat": the worker is not a companion worker, the
  /// server flag is off, the server predates the route (404), the network failed,
  /// or the body was malformed. BEST-EFFORT like [loadHistory]: implementations
  /// never throw, so the tab can never be blocked by the companion.
  ///
  /// NEVER opens, resumes or mints a chat session: a companion worker has no
  /// interview in flight, and minting one here is exactly the bug this fixes for
  /// workers whose profile came from a form.
  Future<CompanionOpening> openCompanion();

  /// ADR-0044 — one companion answer (`POST /chat/companion/message`), with
  /// [ChatTurn.companion] set. Null when the server answers 409 (this worker is
  /// no longer in companion mode — a new interview went live, or the flag was
  /// turned off); the caller then sends the same text down [sendMessage].
  /// Throws a [Failure] on any other error, like [sendMessage].
  Future<ChatTurn?> sendCompanionMessage(String text, {String? submissionId});

  /// ADR-0046 §5.2 — Haan on the edit card: apply [rowIds] (the TICKED rows'
  /// server-minted `row_id`s, 1..3; the values never cross the wire).
  ///
  /// Never throws for the contract answers — a `200` returns
  /// [CompanionEditOutcome.served] with the turn (including the fallback turn
  /// that carries the SAME card back when nothing was written), a `404` returns
  /// [CompanionEditOutcome.gone], a 409 `{reason:"stale"}` returns
  /// [CompanionEditOutcome.stale] with the reviewed turn, and a 409
  /// `{mode:"interview"}` returns [CompanionEditOutcome.interview]. Throws a
  /// [Failure] on any other error.
  Future<CompanionEditResult> confirmCompanionEdit(
    String proposalId,
    List<String> rowIds, {
    String? submissionId,
  });

  /// ADR-0046 §5.2 — Nahi on the edit card. The same three-answer contract as
  /// [confirmCompanionEdit].
  Future<CompanionEditResult> cancelCompanionEdit(
    String proposalId, {
    String? submissionId,
  });
}
