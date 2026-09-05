import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart' show ResumeDocument;
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../../profile/domain/profile_repository.dart';
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

  @override
  List<Object?> get props =>
      <Object?>[status, resumeText, nightShiftReady, document, awaitingDocument];
}

/// Drives the resume screen: a single generate-on-open action. A failure shows
/// the app's standard retry view (rather than the original's stuck spinner).
class ResumeCubit extends Cubit<ResumeState> {
  ResumeCubit(this._repo, this._editRepo, this._profileRepo)
      : super(const ResumeState());

  final ResumeRepository _repo;
  final ResumeEditRepository _editRepo;
  final ProfileRepository _profileRepo;

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
      // whole screen and pushed ResumePhotoHeader's mount past widget tests' fixed
      // settle window, leaking its mock timer. Load the pref in the background and
      // re-emit; an unchanged value dedupes to a no-op (Equatable).
      emit(ResumeState(
        status: ResumeStatus.ready,
        resumeText: text,
        nightShiftReady: state.nightShiftReady,
        // A fresh generate — the structured document fetch below has not
        // resolved yet. The screen shows a loader, not this text, until it
        // does (see ResumeState.awaitingDocument's own doc).
        awaitingDocument: true,
      ));
      // B7 funnel milestone — the worker reached a generated resume. Fired from
      // generate() only (never refresh(), which is a tab-focus re-read of an
      // existing resume) and once per cubit, so it counts workers who got there
      // rather than screen visits. No parameters: the resume is PII end to end.
      if (!_resumeReadyLogged) {
        _resumeReadyLogged = true;
        unawaited(BbAnalytics.instance.log(BbAnalytics.resumeReady));
      }
      // Started together so the document fetch rides alongside the night-shift
      // fetch rather than doubling the wait — both are best-effort UPGRADES
      // over the resume text already on screen. This is a FRESH generation
      // (not a re-read of an existing resume), so the document is fetched
      // WITH RETRY — see [_loadDocumentWithRetry].
      final Future<bool> nightShiftFuture = _loadNightShiftReady();
      final Future<ResumeDocument?> documentFuture = _loadDocumentWithRetry();
      final bool nightShiftReady = await nightShiftFuture;
      final ResumeDocument? document = await documentFuture;
      if (isClosed) return;
      emit(ResumeState(
        status: ResumeStatus.ready,
        resumeText: text,
        nightShiftReady: nightShiftReady,
        document: document,
        // Settled — successfully or not (the retry budget is bounded; see
        // _loadDocumentWithRetry's own doc). Never leaves the worker on the
        // loader forever.
        awaitingDocument: false,
      ));
    } on ProfileIncompleteFailure catch (_) {
      if (isClosed) return;
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
          emit(ResumeState(
            status: ResumeStatus.ready,
            resumeText: retryText,
            awaitingDocument: true,
          ));
          if (!_resumeReadyLogged) {
            _resumeReadyLogged = true;
            unawaited(BbAnalytics.instance.log(BbAnalytics.resumeReady));
          }
          final Future<bool> nightShiftFuture = _loadNightShiftReady();
          final Future<ResumeDocument?> documentFuture =
              _loadDocumentWithRetry();
          final bool nightShiftReady = await nightShiftFuture;
          final ResumeDocument? document = await documentFuture;
          if (isClosed) return;
          emit(ResumeState(
            status: ResumeStatus.ready,
            resumeText: retryText,
            nightShiftReady: nightShiftReady,
            document: document,
            awaitingDocument: false,
          ));
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
      emit(ResumeState(
        status: ResumeStatus.ready,
        resumeText: text,
        nightShiftReady: state.nightShiftReady,
        document: state.document,
      ));
      final Future<bool> nightShiftFuture = _loadNightShiftReady();
      final Future<ResumeDocument?> documentFuture = _loadDocument();
      final bool nightShiftReady = await nightShiftFuture;
      final ResumeDocument? document = await documentFuture;
      if (isClosed) return;
      emit(ResumeState(
        status: ResumeStatus.ready,
        resumeText: text,
        nightShiftReady: nightShiftReady,
        document: document,
      ));
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
      emit(ResumeState(
        status: ResumeStatus.ready,
        resumeText: text,
        awaitingDocument: true,
      ));
      final Future<bool> nightShiftFuture = _loadNightShiftReady();
      final Future<ResumeDocument?> documentFuture = _loadDocumentWithRetry();
      final bool nightShiftReady = await nightShiftFuture;
      final ResumeDocument? document = await documentFuture;
      if (isClosed) return;
      emit(ResumeState(
        status: ResumeStatus.ready,
        resumeText: text,
        nightShiftReady: nightShiftReady,
        document: document,
        awaitingDocument: false,
      ));
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
    emit(ResumeState(
      status: ResumeStatus.ready,
      resumeText: state.resumeText,
      nightShiftReady: nightShiftReady,
      // Preserved, not re-fetched: this is a lightweight prefs-only reload, and
      // the structured document did not change under a night-shift toggle.
      document: state.document,
    ));
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

  /// #1343 — best-effort load of the structured resume document. The
  /// repository itself never throws (see [ResumeRepository.loadResumeDocument]),
  /// but this belt-and-suspenders catch matches [_loadNightShiftReady]: a
  /// hiccup here must NEVER cost the worker the resume text already resolved.
  Future<ResumeDocument?> _loadDocument() async {
    try {
      return await _repo.loadResumeDocument();
    } catch (_) {
      return null;
    }
  }

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
  /// shape of problem). The principled fix is the server exposing
  /// `render_status` on this response so the client polls a real signal
  /// instead of blind-retrying a fixed count; raised as an issue.
  /// Mutable (not `const`), matching the same test-seam shape as
  /// `AppTypography.bundledBrandFonts` — a widget/bloc test sets
  /// [documentPollInterval] to `Duration.zero` (restored in `tearDown`) so
  /// the whole suite does not sit through real multi-second delays every
  /// time a test's mock happens to answer the default `null`.
  static int documentPollMaxAttempts = 6;
  static Duration documentPollInterval = const Duration(seconds: 2);

  /// [_loadDocument], retried on a `null` result — worst case adds ~10s
  /// (5 waits × 2s) before accepting null as final. Stops the instant a
  /// non-null document arrives. See [documentPollMaxAttempts]'s doc for why
  /// this exists: without it, a worker who just finished the trade form (or
  /// just changed a description source) can land on the Resume tab before
  /// the async render job has written the document at all, and see a thin
  /// generic-text fallback instead of the real trade-sheet content until
  /// their next tab-focus or app restart happens to land after the job.
  Future<ResumeDocument?> _loadDocumentWithRetry() async {
    for (int attempt = 0; attempt < documentPollMaxAttempts; attempt++) {
      final ResumeDocument? document = await _loadDocument();
      if (document != null) return document;
      if (isClosed) return null;
      if (attempt < documentPollMaxAttempts - 1) {
        await Future<void>.delayed(documentPollInterval);
      }
    }
    return null;
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
    await _repo.setEmploymentDescriptionSource(employmentId, ownWords: ownWords);
    if (isClosed) return;
    // This write ALSO enqueues an async re-render (same
    // `RESUME_RENDER_QUEUE` the initial generate does — see
    // `worker-employment.service.ts`'s `setDescriptionSource`), so the same
    // race [_loadDocumentWithRetry] guards against applies here too.
    final ResumeDocument? reloaded = await _loadDocumentWithRetry();
    if (isClosed) return;
    emit(ResumeState(
      status: state.status,
      resumeText: state.resumeText,
      nightShiftReady: state.nightShiftReady,
      document: reloaded ?? state.document,
    ));
  }
}
