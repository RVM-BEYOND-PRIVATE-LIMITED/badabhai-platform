import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart'
    show PendingUpdate, ResumeDocument, ResumeHistory;
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../../../core/session/session_repository.dart';
import '../../../profile/domain/profile_repository.dart';
import '../../../profile_tab/domain/profile_summary.dart';
import '../../../profile_tab/domain/profile_summary_repository.dart';
import '../../domain/resume_edit_repository.dart';
import '../../domain/resume_repository.dart';
import '../../domain/resume_safe_fields.dart';

enum ResumeStatus { loading, ready, failed, noProfile }

class ResumeState extends Equatable {
  const ResumeState({
    this.status = ResumeStatus.loading,
    this.resumeText = '',
    this.nightShiftReady = false,
    this.document,
    this.awaitingDocument = false,
    this.renderStatus,
    this.renderedAt,
    this.profileConfirmed,
    this.history = ResumeHistory.empty,
    this.updateFailed = false,
    this.updateLanded = false,
  });

  final ResumeStatus status;
  final String resumeText;
  final bool nightShiftReady;

  /// #1343 — the SAME resume as structured data (GET /resume/document), a
  /// best-effort UPGRADE over [resumeText]. Null when the server has none yet
  /// OR the fetch failed — the screen must fall back to parsing [resumeText]
  /// on null, never treat it as "no resume".
  final ResumeDocument? document;

  /// True for the SHORT window right after a fresh generate/handoff
  /// (`generate()`/`showGenerated()`) while [document] is still being
  /// fetched WITH RETRY (see [_loadDocumentWithRetry]) — `status` is already
  /// `ready` (the text landed) but the authoritative structured render has
  /// not resolved yet. The screen must show a LOADER while this is true,
  /// never the [resumeText] fallback — see this class' own doc note on
  /// [document] for why that fallback under-represents a form-first
  /// worker's real content, which is exactly the "wrong info flashes then
  /// gets replaced" symptom this flag exists to prevent.
  ///
  /// ALWAYS false outside that one window: never set by [refresh] (a
  /// tab-focus reread of an ALREADY-shown resume — a loader there would
  /// regress "a stale resume beats no resume"), and flipped back to `false`
  /// the moment the retry settles, successfully or not — a worker is never
  /// left on the loader forever, even if the retry budget runs out.
  final bool awaitingDocument;

  /// The PDF's REAL state as the server reports it (`'pending' | 'rendered' |
  /// 'failed'`), or null when unknown. A RAW TOKEN — never rendered.
  ///
  /// The tab's READY pill reads [pdfRendered] and nothing else (ruling R6).
  /// It used to be painted from "there is resume text", which says nothing
  /// about whether a PDF exists — so the worker got a green success mark and
  /// then "PDF taiyaar ho rahi hai…" on tapping Download.
  ///
  /// Carried through EVERY `ready` emit, including the lightweight prefs-only
  /// reloads: a stale-but-true status beats blanking a pill the worker
  /// already saw.
  final String? renderStatus;

  /// WHEN that render finished (`rendered_at`), straight from the same call as
  /// [renderStatus]. A RAW timestamp the screen never prints.
  ///
  /// #1688 — it is carried in state for ONE reason: to be the BASELINE a
  /// write-then-reload poll compares against. A write that forces a re-render
  /// (a photo, a language, a preference, a work-history source switch) leaves
  /// the row `rendered` with the OLD document still in place, so "non-null and
  /// not stale-pending" was satisfied on the very first poll and the reload
  /// returned what was already on screen. Holding the PRE-WRITE value lets the
  /// poll ask the only question that actually distinguishes them: has
  /// `rendered_at` MOVED?
  final DateTime? renderedAt;

  /// R7 — whether the worker's PROFILE is confirmed, from
  /// `GET /workers/me/profile-summary`. Three-valued on purpose:
  ///  * `false` → the DRAFT pill shows;
  ///  * `true` → it is hidden;
  ///  * `null` (unknown: no repository wired, or the read failed) → ALSO
  ///    hidden.
  ///
  /// Unknown must never show DRAFT. The resume TEXT cannot answer this —
  /// ai-service stamps "WORKER PROFILE (DRAFT)" on every resume it builds
  /// (backend gap B11), so the old text-parsed pill was permanently true and
  /// therefore told a confirmed worker their profile was a draft forever.
  final bool? profileConfirmed;

  /// #1687 — the worker's resume history, newest first, as the server windows
  /// it, plus `pending_update`.
  ///
  /// [ResumeHistory.empty] means "no section": an older server, a failed read,
  /// or genuinely nothing yet. All three render the tab exactly as it looked
  /// before this feature existed — the history is an ADDITION to a screen that
  /// already works and must never be able to break it.
  final ResumeHistory history;

  /// #1688 — the accepted chat update did not land: the server said `failed`,
  /// or the client's own deadline passed. Terminal; the screen offers the
  /// ordinary preview → confirm path as the way forward.
  final bool updateFailed;

  /// #1688 — the accepted update HAS landed and the new resume is on screen.
  /// Set for the one emit that carries it; the screen shows a brief
  /// "Naya resume taiyaar hai" highlight off it.
  final bool updateLanded;

  /// True only when the server said the PDF is rendered. Fails closed:
  /// absent / pending / failed are all "not ready".
  bool get pdfRendered => renderStatus == 'rendered';

  /// #1688 — an accepted update is still on its way. Fails closed: an unknown
  /// `pending_update.status` is NOT "in progress", so a future server value
  /// can never leave a worker watching a card forever.
  bool get updateInProgress => history.pendingUpdate?.isInProgress ?? false;

  @override
  List<Object?> get props => <Object?>[
    status,
    resumeText,
    nightShiftReady,
    document,
    awaitingDocument,
    renderStatus,
    renderedAt,
    profileConfirmed,
    history,
    updateFailed,
    updateLanded,
  ];
}

/// Drives the resume screen: a single generate-on-open action. A failure shows
/// the app's standard retry view (rather than the original's stuck spinner).
class ResumeCubit extends Cubit<ResumeState> {
  ResumeCubit(
    this._repo,
    this._editRepo,
    this._profileRepo, {
    ProfileSummaryRepository? profileSummaryRepository,
    SessionRepository? sessionRepository,
  }) : _injectedSummaryRepo = profileSummaryRepository,
       _injectedSessionRepo = sessionRepository,
       super(const ResumeState());

  final ResumeRepository _repo;
  final ResumeEditRepository _editRepo;
  final ProfileRepository _profileRepo;

  /// R7's source, INJECTABLE but not required.
  ///
  /// Not a required constructor argument on purpose: the DI registration in
  /// `locator.dart` is owned by no screen package in this redesign, so
  /// widening the signature there would have meant editing a file outside
  /// this change. Left null (production), the getter below resolves it from
  /// the locator IF it is registered — and simply goes without when it is
  /// not, which is what keeps the partial-locator widget tests working. A
  /// test that wants to exercise the DRAFT pill passes a fake here.
  final ProfileSummaryRepository? _injectedSummaryRepo;

  /// #1763 — the held CHAT session, read only to answer one question: is the
  /// worker in the middle of an interview right now? Injectable on the same
  /// terms as [_injectedSummaryRepo], for the same reason.
  final SessionRepository? _injectedSessionRepo;

  /// True while a load is in flight. The tab-focus refetch and the screen's own
  /// create:-time load can both fire around a first visit, and a second
  /// concurrent load would double the network work and race its emits.
  bool _loading = false;

  /// True once the B7 "resume ready" milestone has been logged for this cubit.
  bool _resumeReadyLogged = false;

  /// Loads the resume — reusing the existing one unless [force].
  ///
  /// [force] is for a deliberate rebuild after the worker edits their NAME (it
  /// is baked in at generation time, so a PATCHed name is invisible until the
  /// resume is regenerated). It re-POSTs generate, which server-side also resets
  /// the PDF to pending and re-enqueues the render, so the downloaded file
  /// carries the new name too (#398). Never force on a routine open: it spends
  /// one of the worker's 5 daily generates and throws away the rendered PDF.
  Future<void> generate({bool force = false}) async {
    if (_loading) return; // never run two loads at once
    _loading = true;
    emit(const ResumeState(status: ResumeStatus.loading));
    try {
      final String text = await _repo.generateResume(force: force);
      if (isClosed) return; // screen popped before generation resolved
      // #820 — a generate that "succeeds" with no text is NOT a resume (an empty
      // body, or a render that produced nothing). Emitting `ready` here painted
      // the celebratory "Resume taiyaar ✓" banner over a blank card and stuck
      // there (refresh/tab-focus keep re-reading the same empty text). Fail closed
      // to the standard retry view instead — and do not log the B7 milestone or
      // fetch the night-shift pref for a resume that does not exist.
      if (_isBlank(text)) {
        emit(const ResumeState(status: ResumeStatus.failed));
        return;
      }
      // Emit `ready` with the text IMMEDIATELY — do NOT block the first paint on
      // the night-shift pref. The resume text is the product; the night-shift flag
      // is garnish (like the photo). Gating `ready` on this extra fetch delayed the
      // whole screen and pushed the profile card's mount past widget tests' fixed
      // settle window, leaking its mock timer. Load the pref in the background and
      // re-emit; an unchanged value dedupes to a no-op (Equatable).
      emit(
        ResumeState(
          status: ResumeStatus.ready,
          resumeText: text,
          nightShiftReady: state.nightShiftReady,
          // A fresh generate — the structured document fetch below has not
          // resolved yet. The screen shows a loader, not this text, until it
          // does (see ResumeState.awaitingDocument's own doc).
          awaitingDocument: true,
        ),
      );
      // B7 funnel milestone — the worker reached a generated resume. Fired from
      // generate() only (never refresh(), which is a tab-focus re-read of an
      // existing resume) and once per cubit, so it counts workers who got there
      // rather than screen visits. No parameters: the resume is PII end to end.
      if (!_resumeReadyLogged) {
        _resumeReadyLogged = true;
        unawaited(BbAnalytics.instance.log(BbAnalytics.resumeReady));
      }
      // Started together so the document fetch rides alongside the night-shift
      // and profile-status fetches rather than tripling the wait — all three
      // are best-effort UPGRADES over the resume text already on screen. This
      // is a FRESH generation (not a re-read of an existing resume), so the
      // document is fetched WITH RETRY — see [_loadDocumentWithRetry].
      final Future<bool> nightShiftFuture = _loadNightShiftReady();
      final Future<ResumeDocumentSnapshot> documentFuture =
          _loadDocumentWithRetry();
      final Future<bool?> confirmedFuture = _loadProfileConfirmed();
      final bool nightShiftReady = await nightShiftFuture;
      final ResumeDocumentSnapshot snapshot = await documentFuture;
      final bool? confirmed = await confirmedFuture;
      if (isClosed) return;
      emit(
        ResumeState(
          status: ResumeStatus.ready,
          resumeText: text,
          nightShiftReady: nightShiftReady,
          document: snapshot.document,
          renderStatus: snapshot.renderStatus,
          renderedAt: snapshot.renderedAt,
          profileConfirmed: confirmed,
          // Settled — successfully or not (the retry budget is bounded; see
          // _loadDocumentWithRetry's own doc). Never leaves the worker on the
          // loader forever.
          awaitingDocument: false,
        ),
      );
    } on ProfileIncompleteFailure catch (_) {
      if (isClosed) return;
      // #1763 — NEVER SELF-HEAL OUT OF A LIVE INTERVIEW.
      //
      // The self-heal extracts and CONFIRMS, and `extractProfile` sends whatever
      // chat session the app holds. For a worker three answers into the interview
      // that confirmed a thin profile from those three answers — and because the
      // server then had an extraction for that session, the finished interview
      // was deduplicated onto the early job, so his full answers never became his
      // profile. He never chose to finish early; only the preview's
      // "Phir bhi profile banaiye" may confirm a partial interview.
      //
      // So it runs only where it was meant to: the #1371 form handover, where the
      // profile is missing because extraction was SKIPPED and no chat session is
      // held. Mid-interview he gets noProfile, whose own screen offers the way
      // back to the chat.
      if (_interviewInProgress) {
        emit(const ResumeState(status: ResumeStatus.noProfile));
        return;
      }
      // #1371 — form handover skips extraction, so the profile may not exist
      // yet. Trigger extraction (idempotent — a normal-profiled worker's call
      // dedupes server-side), confirm it so resume generation can proceed, and
      // retry once. A second failure surfaces as noProfile so the worker is
      // never stuck in a loop.
      try {
        await _profileRepo.extractProfile();
      } catch (_) {
        // Extraction failed or timed out — fall through to noProfile.
      }
      if (isClosed) return;
      try {
        await _profileRepo.confirmProfile();
      } catch (_) {
        // Confirm failed — fall through to noProfile.
      }
      if (isClosed) return;
      try {
        final String retryText = await _repo.generateResume(force: false);
        if (isClosed) return;
        if (!_isBlank(retryText)) {
          // THIS retry path was landing a worker on the Resume tab with the
          // thin resumeText fallback and no loader at all — awaitingDocument
          // defaults to false, and nothing here ever fetched the structured
          // document. It is reachable disproportionately by FORM-FIRST
          // workers (this whole branch only runs because "form handover
          // skips extraction", per the class doc above), i.e. exactly the
          // population the awaitingDocument fix in the happy path below was
          // built for — so it needs the identical two-emit dance, not a
          // shortcut. See ResumeState.awaitingDocument's own doc.
          emit(
            ResumeState(
              status: ResumeStatus.ready,
              resumeText: retryText,
              awaitingDocument: true,
            ),
          );
          if (!_resumeReadyLogged) {
            _resumeReadyLogged = true;
            unawaited(BbAnalytics.instance.log(BbAnalytics.resumeReady));
          }
          final Future<bool> nightShiftFuture = _loadNightShiftReady();
          final Future<ResumeDocumentSnapshot> documentFuture =
              _loadDocumentWithRetry();
          final Future<bool?> confirmedFuture = _loadProfileConfirmed();
          final bool nightShiftReady = await nightShiftFuture;
          final ResumeDocumentSnapshot snapshot = await documentFuture;
          final bool? confirmed = await confirmedFuture;
          if (isClosed) return;
          emit(
            ResumeState(
              status: ResumeStatus.ready,
              resumeText: retryText,
              nightShiftReady: nightShiftReady,
              document: snapshot.document,
              renderStatus: snapshot.renderStatus,
          renderedAt: snapshot.renderedAt,
              profileConfirmed: confirmed,
              awaitingDocument: false,
            ),
          );
          return;
        }
      } catch (_) {
        // Retry also failed — fall through to noProfile.
      }
      if (isClosed) return;
      emit(const ResumeState(status: ResumeStatus.noProfile));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const ResumeState(status: ResumeStatus.failed));
    } finally {
      _loading = false;
    }
  }

  /// Tab-focus refetch (T4) — the Resume tab came back into view.
  ///
  /// NEVER forces. A force here would re-POST /resume/generate on every tab
  /// switch, which server-side overwrites the row, resets the PDF to 'pending'
  /// and re-enqueues the render — so the worker's already-rendered PDF would be
  /// binned on each visit and their 5/day generate cap burned to do it. This is
  /// a read that REUSES the existing resume.
  ///
  /// Also does not emit `loading` and does not wipe on failure: the worker is
  /// looking at a readable resume, and a blip on a background refetch must not
  /// replace it with a spinner or an error screen. A stale resume beats no
  /// resume.
  Future<void> refresh() async {
    if (_loading) return;
    _loading = true;
    try {
      final String text = await _repo.generateResume(); // force: false → reuse
      if (isClosed) return;
      // #820 — an empty reused resume must neither fake a `ready` nor overwrite a
      // readable one. Mirror the failure guard below: only surface `failed` when
      // there was nothing good on screen to begin with (a stale resume beats a
      // blank one).
      if (_isBlank(text)) {
        if (state.status != ResumeStatus.ready) {
          emit(const ResumeState(status: ResumeStatus.failed));
        }
        return;
      }
      // Same as generate(): surface the (reused) text immediately, then refresh the
      // night-shift pref in the background so the first paint isn't gated on it.
      // The render status and profile status already on screen are CARRIED, not
      // cleared — a background re-read must not blink the worker's READY pill off.
      emit(
        ResumeState(
          status: ResumeStatus.ready,
          resumeText: text,
          nightShiftReady: state.nightShiftReady,
          document: state.document,
          renderStatus: state.renderStatus,
          renderedAt: state.renderedAt,
          profileConfirmed: state.profileConfirmed,
        ),
      );
      final Future<bool> nightShiftFuture = _loadNightShiftReady();
      final Future<ResumeDocumentSnapshot> documentFuture = _loadDocument();
      final Future<bool?> confirmedFuture = _loadProfileConfirmed();
      final bool nightShiftReady = await nightShiftFuture;
      final ResumeDocumentSnapshot snapshot = await documentFuture;
      final bool? confirmed = await confirmedFuture;
      if (isClosed) return;
      emit(
        ResumeState(
          status: ResumeStatus.ready,
          resumeText: text,
          nightShiftReady: nightShiftReady,
          document: snapshot.document,
          renderStatus: snapshot.renderStatus,
          renderedAt: snapshot.renderedAt,
          profileConfirmed: confirmed,
        ),
      );
    } on ProfileIncompleteFailure {
      if (isClosed) return;
      if (state.status != ResumeStatus.ready) {
        emit(const ResumeState(status: ResumeStatus.noProfile));
      }
    } on Failure catch (_) {
      if (isClosed) return;
      // Keep whatever the worker can already read; only surface the failure
      // when there was nothing good on screen to begin with.
      if (state.status != ResumeStatus.ready) {
        emit(const ResumeState(status: ResumeStatus.failed));
      }
    } finally {
      _loading = false;
    }
  }

  /// Display an already-generated resume (generated upstream by the Building
  /// screen) without re-running generation.
  ///
  /// MUST HOLD [_loading] FOR ITS WHOLE DURATION — this is the actual bug
  /// behind 3 rounds of "the resume tab still shows incomplete info first",
  /// and it was never in this method's own emit sequence (which was already
  /// correct). The Building screen hands off via `context.go`, landing on
  /// this cubit's `create:` on the VERY FIRST build of the resume tab
  /// branch — before the shell's own `TabFocus` value has caught up (it
  /// defaults to the jobs tab). `_syncActiveTabAfterBuild` (router.dart)
  /// corrects that ONE frame later via `addPostFrameCallback`, which fires
  /// `TabFocusRefetch` → [refresh]. Without a shared mutex, that [refresh]
  /// call races the document poll below: `_loading` was still `false` (this
  /// method never touched it), so [refresh] ran, reused the already-created
  /// resume, and emitted `ready` with `awaitingDocument` defaulting to
  /// `false` and `document` still `null` — the exact thin/incomplete
  /// content the loader exists to hide, landing IN BETWEEN this method's
  /// own correct first and second emits. A worker on their FIRST EVER
  /// resume never taps anything to trigger this — the automatic post-frame
  /// tab-sync alone reproduces it every time.
  Future<void> showGenerated(String text) async {
    if (_loading) return; // never race a concurrent refresh()/generate()
    _loading = true;
    try {
      // #820 — the Building screen can hand off an empty body; never present it as a
      // ready resume. Fail closed to the retry view.
      if (_isBlank(text)) {
        emit(const ResumeState(status: ResumeStatus.failed));
        return;
      }
      // This hands off a JUST-generated resume (from the Building screen,
      // right after trade-form/chat completion). The document fetch below is
      // WITH RETRY (see [_loadDocumentWithRetry]) — the screen shows a loader
      // for this window (awaitingDocument), never the bare text, so a
      // form-first worker's thin fallback narrative never flashes on screen
      // only to be replaced a moment later by the real structured content.
      emit(
        ResumeState(
          status: ResumeStatus.ready,
          resumeText: text,
          awaitingDocument: true,
        ),
      );
      final Future<bool> nightShiftFuture = _loadNightShiftReady();
      final Future<ResumeDocumentSnapshot> documentFuture =
          _loadDocumentWithRetry();
      final Future<bool?> confirmedFuture = _loadProfileConfirmed();
      final bool nightShiftReady = await nightShiftFuture;
      final ResumeDocumentSnapshot snapshot = await documentFuture;
      final bool? confirmed = await confirmedFuture;
      if (isClosed) return;
      emit(
        ResumeState(
          status: ResumeStatus.ready,
          resumeText: text,
          nightShiftReady: nightShiftReady,
          document: snapshot.document,
          renderStatus: snapshot.renderStatus,
          renderedAt: snapshot.renderedAt,
          profileConfirmed: confirmed,
          awaitingDocument: false,
        ),
      );
    } finally {
      _loading = false;
    }
  }

  /// Reload only the night-shift pref from the server — lightweight, no
  /// resume-text refetch. Used after the edit screen saves a prefs-only change.
  Future<void> refreshNightShift() async {
    // #820 — this re-emits `ready` reusing the current text; guard so it can never
    // manufacture a `ready` out of an empty resume (it is only meaningful over one
    // already on screen).
    if (_isBlank(state.resumeText)) return;
    final bool nightShiftReady = await _loadNightShiftReady();
    if (isClosed) return;
    emit(
      ResumeState(
        status: ResumeStatus.ready,
        resumeText: state.resumeText,
        nightShiftReady: nightShiftReady,
        // Preserved, not re-fetched: this is a lightweight prefs-only reload, and
        // neither the structured document nor the PDF's render state nor the
        // profile's confirmed state changed under a night-shift toggle.
        document: state.document,
        renderStatus: state.renderStatus,
          renderedAt: state.renderedAt,
        profileConfirmed: state.profileConfirmed,
      ),
    );
  }

  /// A resume body that is empty or only whitespace is not a resume — the screen
  /// must never paint the "Resume taiyaar ✓" success over it (#820).
  static bool _isBlank(String text) => text.trim().isEmpty;

  Future<bool> _loadNightShiftReady() async {
    try {
      final ResumeSafeFields fields = await _editRepo.load();
      return fields.nightShiftReady;
    } catch (_) {
      return false;
    }
  }

  /// R7 — the DRAFT pill's only honest source, read best-effort.
  ///
  /// Returns null when there is nothing to read (no repository registered) or
  /// the read failed. Null is NOT "draft": an unknown profile status hides the
  /// pill, because showing DRAFT on a confirmed worker's resume is the exact
  /// bug this replaced.
  Future<bool?> _loadProfileConfirmed() async {
    final ProfileSummaryRepository? repo = _summaryRepo;
    if (repo == null) return null;
    try {
      final ProfileSummary summary = await repo.summary();
      // `verified` already means `confirmed_at != null || status ==
      // 'confirmed'` (profile_summary_repository_impl.dart) — the same
      // question, mapped once, rather than re-deriving it from the raw status
      // token here.
      return summary.verified;
    } catch (_) {
      return null;
    }
  }

  /// #1763 — TRUE while the worker is still answering a chat interview.
  ///
  /// A held chat session id IS that signal, and it is exact: the client drops
  /// the id the moment the server reports the session ended
  /// ([SessionRepository.clearChatSession]), so an id still in hand means an
  /// interview that has not ended. A form-road worker — the #1371 case the
  /// self-heal was built for — holds none, because the form road opens no chat.
  ///
  /// Unknown (no session repository registered, as in the partial-locator widget
  /// tests) reads FALSE, which keeps today's self-heal behaviour for them.
  bool get _interviewInProgress {
    final SessionRepository? session = _injectedSessionRepo ??
        (locator.isRegistered<SessionRepository>()
            ? locator<SessionRepository>()
            : null);
    final String? id = session?.sessionId;
    return id != null && id.isNotEmpty;
  }

  /// The injected repository, else the registered one, else none. See
  /// [_injectedSummaryRepo] for why it is resolved here rather than required.
  ProfileSummaryRepository? get _summaryRepo {
    final ProfileSummaryRepository? injected = _injectedSummaryRepo;
    if (injected != null) return injected;
    return locator.isRegistered<ProfileSummaryRepository>()
        ? locator<ProfileSummaryRepository>()
        : null;
  }

  /// #1343 — best-effort load of the structured resume document AND the PDF's
  /// render state. The repository itself never throws (see
  /// [ResumeRepository.loadResumeDocument]), but this belt-and-suspenders
  /// catch matches [_loadNightShiftReady]: a hiccup here must NEVER cost the
  /// worker the resume text already resolved.
  Future<ResumeDocumentSnapshot> _loadDocument() async {
    try {
      return await _repo.loadResumeDocument();
    } catch (_) {
      return const ResumeDocumentSnapshot();
    }
  }

  /// #1688 — the backoff and the hard ceiling for [watchResumeUpdate].
  ///
  /// MUTABLE STATICS, the same test-seam shape as [documentPollInterval]: a
  /// widget test's binding asserts no pending timers, so a real 3-second wait
  /// inside a pumped test fails as a binding assertion rather than anything
  /// readable. A harness zeroes these and restores the literals below.
  ///
  /// [updateWatchBudget] is a HARD CLIENT DEADLINE and is not negotiable with
  /// the server: nothing in the contract guarantees that an accepted update
  /// ever terminates, so the client has to be able to stop on its own. Three
  /// minutes is sized off the server's own chain — extraction (an AI call,
  /// ~30-90s), auto-confirm, resume generation, then the PDF render.
  static Duration updatePollInitial = const Duration(seconds: 3);
  static Duration updatePollMax = const Duration(seconds: 10);
  static Duration updateWatchBudget = const Duration(minutes: 3);

  /// True while [watchResumeUpdate] is polling, so a tab focus, an app resume
  /// and the screen's own create:-time call cannot start three of them.
  bool _watchingUpdate = false;

  /// #1687 — (re)reads the resume history and emits it. Best-effort by
  /// contract: the repository never throws, so this cannot fail the screen.
  ///
  /// Deliberately NOT part of [refresh]: refresh holds the [_loading] mutex and
  /// early-returns while any load is in flight, which would silently drop a
  /// history read fired by the same tab focus.
  Future<void> loadHistory() async {
    final ResumeHistory history = await _readHistory();
    if (isClosed) return;
    emit(_withHistory(history));
  }

  /// [ResumeRepository.loadResumeHistory] behind a belt-and-suspenders catch,
  /// exactly like [_loadDocument].
  ///
  /// The repository already promises never to throw. This is here because the
  /// PROMISE is what the screen depends on, and an optional section must not
  /// be able to take down a resume the worker is looking at if that promise is
  /// ever broken — by a future edit, or by a double in a test.
  Future<ResumeHistory> _readHistory() async {
    try {
      return await _repo.loadResumeHistory();
    } catch (_) {
      return ResumeHistory.empty;
    }
  }

  /// #1688 — waits for an update the worker accepted in chat.
  ///
  /// Polls `GET /resume/history` while `pending_update.status` is
  /// `in_progress`, backing off from [updatePollInitial] to [updatePollMax],
  /// and stops for ONE of four reasons, every one of them terminal:
  ///
  ///  * the update LANDED (`pending_update` is gone) — the new resume is
  ///    re-read and [ResumeState.updateLanded] is set for that emit;
  ///  * the server said `failed`;
  ///  * this client's own [updateWatchBudget] ran out;
  ///  * the cubit closed (the worker left the tab, or the app).
  ///
  /// The worker is NEVER left spinning: the last two exist precisely because
  /// the wire contract cannot promise the first two will ever arrive.
  Future<void> watchResumeUpdate() async {
    if (_watchingUpdate || isClosed) return;
    _watchingUpdate = true;
    final DateTime deadline = DateTime.now().add(updateWatchBudget);
    Duration wait = updatePollInitial;
    try {
      while (!isClosed) {
        final ResumeHistory history = await _readHistory();
        if (isClosed) return;
        final PendingUpdate? pending = history.pendingUpdate;

        if (pending == null) {
          // Nothing pending any more. Either it landed, or there never was
          // one — both are "stop waiting". The resume itself is re-read FIRST
          // so the tab shows the NEW text/document, not the one the worker
          // accepted an update away from; the landed flag is emitted AFTER
          // that read, because `refresh` emits a state of its own and would
          // otherwise wipe the very flag the highlight is keyed off.
          await refresh();
          if (isClosed) return;
          emit(_withHistory(history, landed: true));
          return;
        }
        if (pending.hasFailed) {
          emit(_withHistory(history, failed: true));
          return;
        }
        if (!pending.isInProgress) {
          // A status this build has never heard of. Terminal, and SILENT: the
          // app does not understand it, so it may neither keep the worker
          // waiting on it nor tell them it failed. Both would be inventions.
          emit(_withHistory(history));
          return;
        }
        emit(_withHistory(history));

        // Checked AFTER a poll, never before: a zeroed budget in a test must
        // still observe one real answer, and a worker whose update lands on
        // the last poll must still be shown it.
        if (!DateTime.now().isBefore(deadline)) {
          emit(_withHistory(history, failed: true));
          return;
        }
        await Future<void>.delayed(wait);
        final Duration next = wait * 2;
        wait = next > updatePollMax ? updatePollMax : next;
      }
    } finally {
      _watchingUpdate = false;
    }
  }

  /// Carries EVERY field the screen is already showing, exactly like the other
  /// background re-reads here: a history poll must never blank a resume the
  /// worker is looking at.
  ResumeState _withHistory(
    ResumeHistory history, {
    bool failed = false,
    bool landed = false,
  }) =>
      ResumeState(
        status: state.status,
        resumeText: state.resumeText,
        nightShiftReady: state.nightShiftReady,
        document: state.document,
        // Carried like every other field: a history read that landed mid-wait
        // must not drop the loader flag and flash the text fallback at a
        // worker whose structured document is still being written.
        awaitingDocument: state.awaitingDocument,
        renderStatus: state.renderStatus,
        renderedAt: state.renderedAt,
        profileConfirmed: state.profileConfirmed,
        history: history,
        updateFailed: failed,
        updateLanded: landed,
      );

  /// #1687 — a signed url for ONE history entry's pdf. Mirrors
  /// [resolveDownloadUrl] (including letting a [Failure] propagate so the
  /// screen can name the real reason) but for a resume the worker PICKED,
  /// rather than whatever the session last touched.
  Future<String?> resolveDownloadUrlFor(String resumeId) =>
      _repo.resumeDownloadUrlFor(resumeId);

  /// [reportShared] for one history entry. Best-effort, never thrown.
  Future<void> reportSharedFor(String resumeId, String channel) =>
      _repo.reportSharedFor(resumeId, channel);

  /// How many times [_loadDocumentWithRetry] re-checks a `null` document
  /// before giving up, and how long it waits between checks. `GET
  /// /resume/document` reads a STORED column (`resumeDocument`) that only a
  /// server-side async render job writes — the write that triggered this
  /// load (a fresh generate, or a description-source change) only ENQUEUES
  /// that job and returns immediately, so a null on the first check is
  /// routinely just the job not having landed yet, not "no document exists".
  /// A CEILING to catch the common case, not a tuned value — the real
  /// number should come from measured render-job p50/p95 (see
  /// [kProfileExtractWaitBudget]'s own doc for the same caveat on the same
  /// shape of problem). The response now carries `render_status`, so a
  /// future change can poll that real signal instead of blind-retrying a
  /// fixed count; the retry is kept as-is here because switching the loop's
  /// exit condition is a behaviour change, not a re-skin.
  /// Mutable (not `const`), matching the same test-seam shape as
  /// `AppTypography.bundledBrandFonts` — a widget/bloc test sets
  /// [documentPollInterval] to `Duration.zero` (restored in `tearDown`) so
  /// the whole suite does not sit through real multi-second delays every
  /// time a test's mock happens to answer the default `null`.
  static int documentPollMaxAttempts = 6;
  static Duration documentPollInterval = const Duration(seconds: 2);

  /// [_loadDocument], retried on a `null` document — worst case adds ~10s
  /// (5 waits × 2s) before accepting null as final. Stops the instant a
  /// FRESH document arrives. See [documentPollMaxAttempts]'s doc for why
  /// this exists: without it, a worker who just finished the trade form (or
  /// just changed a description source) can land on the Resume tab before
  /// the async render job has written the document at all, and see a thin
  /// generic-text fallback instead of the real trade-sheet content until
  /// their next tab-focus or app restart happens to land after the job.
  ///
  /// FRESH means non-null AND not [ResumeDocumentSnapshot.isStalePendingDocument].
  /// A manual regenerate resets the row to `pending` with `rendered_at` null
  /// while leaving the previous render's document in place, so stopping on
  /// the first non-null document lands on the OLD skills after a section-walk
  /// edit (back to step 1, change, submit). The stale shape keeps polling;
  /// everything else behaves exactly as before (a null/absent status is
  /// never stale, so older servers and all existing stubs are unaffected).
  ///
  /// Returns the LAST snapshot, not an empty one, when the budget runs out:
  /// a worker on the legacy text path has no document by definition, and
  /// their PDF's `render_status` still has to reach the banner.
  /// Whether [snapshot] is the document this poll was waiting for.
  ///
  /// Without a baseline this is the ORIGINAL rule, unchanged: non-null and not
  /// the stale-under-pending shape. Every caller that has no pre-write
  /// timestamp keeps exactly today's behaviour.
  ///
  /// #1688 — with a [since] baseline it also demands that the render actually
  /// MOVED. A FORCED re-render (a photo, a language, a qualification, a
  /// preference, a work-history source switch) does not pass through
  /// `pending`: the row stays `rendered` with the PREVIOUS document and the
  /// PREVIOUS `rendered_at` until the new render lands. The old rule was
  /// satisfied on the first poll and handed the caller back the very document
  /// it had just written over — the worker saw their old skills after editing
  /// them. Comparing against the pre-write timestamp is the only test that
  /// tells those two states apart.
  ///
  /// A snapshot with a null [ResumeDocumentSnapshot.renderedAt] under a
  /// baseline is NOT fresh: that is the stale-pending shape, and it is what
  /// the poll is waiting to see replaced.
  static bool _isFresh(ResumeDocumentSnapshot snapshot, DateTime? since) {
    if (snapshot.document == null || snapshot.isStalePendingDocument) {
      return false;
    }
    if (since == null) return true;
    final DateTime? at = snapshot.renderedAt;
    if (at == null) return false;
    return at.isAfter(since);
  }

  Future<ResumeDocumentSnapshot> _loadDocumentWithRetry({
    DateTime? since,
  }) async {
    ResumeDocumentSnapshot snapshot = const ResumeDocumentSnapshot();
    for (int attempt = 0; attempt < documentPollMaxAttempts; attempt++) {
      snapshot = await _loadDocument();
      if (_isFresh(snapshot, since)) {
        return snapshot;
      }
      if (isClosed) return snapshot;
      if (attempt < documentPollMaxAttempts - 1) {
        await Future<void>.delayed(documentPollInterval);
      }
    }
    return snapshot;
  }

  /// Resolves a short-lived signed url for the resume PDF, or null if it could
  /// not be fetched (the screen then shows a user-safe message). Does NOT change
  /// [ResumeState] — the resume is already shown; this is a side action. The url
  /// is returned for an immediate IN-APP fetch only and is never stored or
  /// logged. Lets a [Failure] PROPAGATE (does not swallow it to null) so
  /// `downloadSignedPdf` can surface the ACTUAL reason (server / 401 /
  /// PDF-not-rendered) instead of a blank generic line.
  Future<String?> resolveDownloadUrl() => _repo.resumeDownloadUrl();

  /// Best-effort report to the server that the worker shared their resume
  /// (`resume.shared`, #1317). Fire-and-forget AFTER a successful native share;
  /// [channel] is a closed kResumeShareChannels enum token. Does NOT touch
  /// [ResumeState] — the resume is already shown and the share already happened,
  /// so this is a pure side-signal; the repository swallows any failure.
  Future<void> reportShared(String channel) => _repo.reportShared(channel);

  /// #1353/#1354 — the worker chooses which text prints for ONE work-history
  /// entry: [ownWords] `true` keeps what they typed, `false` (re-)selects the
  /// model's rewrite. Lets a [Failure] PROPAGATE (mirrors [resolveDownloadUrl]):
  /// the worker tapped a specific, deliberate choice about a sentence carrying
  /// their name, so the caller must show an honest failure rather than have the
  /// screen silently look like it worked.
  ///
  /// On success, RE-FETCHES the structured document — the app's usual
  /// write-then-reload convention (mirrors how the finishing/trade-form
  /// screens reload after a save) — so the choice is reflected from the
  /// server's OWN next answer rather than guessed at locally:
  /// [ResumeEmploymentDto.work] is a composed string this client cannot safely
  /// reconstruct itself. If the reload itself hiccups, the document already on
  /// screen is KEPT (mirrors [refreshNightShift]: a stale document beats a
  /// blanked one) rather than losing what the write just confirmed.
  Future<void> setEmploymentDescriptionSource(
    String employmentId, {
    required bool ownWords,
  }) async {
    await _repo.setEmploymentDescriptionSource(
      employmentId,
      ownWords: ownWords,
    );
    if (isClosed) return;
    // This write ALSO enqueues an async re-render (same
    // `RESUME_RENDER_QUEUE` the initial generate does — see
    // `worker-employment.service.ts`'s `setDescriptionSource`), so the same
    // race [_loadDocumentWithRetry] guards against applies here too.
    // #1688 — the PRE-WRITE render time is the baseline: this write forces a
    // re-render that never passes through `pending`, so "has rendered_at
    // moved?" is the only question that distinguishes the new document from
    // the one just overwritten.
    final ResumeDocumentSnapshot reloaded =
        await _loadDocumentWithRetry(since: state.renderedAt);
    if (isClosed) return;
    emit(
      ResumeState(
        status: state.status,
        resumeText: state.resumeText,
        nightShiftReady: state.nightShiftReady,
        document: reloaded.document ?? state.document,
        renderStatus: reloaded.renderStatus ?? state.renderStatus,
        renderedAt: reloaded.renderedAt ?? state.renderedAt,
        profileConfirmed: state.profileConfirmed,
      ),
    );
  }

  /// #1492 — the answer-level twin of [setEmploymentDescriptionSource], for the
  /// fresher's training sentence. Same enqueue-then-reload race, so the same
  /// [_loadDocumentWithRetry] guard.
  Future<void> setAnswerTextSource(
    String attributeKey, {
    required bool ownWords,
  }) async {
    await _repo.setAnswerTextSource(attributeKey, ownWords: ownWords);
    if (isClosed) return;
    // #1688 — the PRE-WRITE render time is the baseline: this write forces a
    // re-render that never passes through `pending`, so "has rendered_at
    // moved?" is the only question that distinguishes the new document from
    // the one just overwritten.
    final ResumeDocumentSnapshot reloaded =
        await _loadDocumentWithRetry(since: state.renderedAt);
    if (isClosed) return;
    emit(
      ResumeState(
        status: state.status,
        resumeText: state.resumeText,
        nightShiftReady: state.nightShiftReady,
        document: reloaded.document ?? state.document,
        renderStatus: reloaded.renderStatus ?? state.renderStatus,
        renderedAt: reloaded.renderedAt ?? state.renderedAt,
        profileConfirmed: state.profileConfirmed,
      ),
    );
  }
}
