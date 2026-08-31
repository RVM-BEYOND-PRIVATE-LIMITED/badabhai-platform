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
  });

  final ResumeStatus status;
  final String resumeText;
  final bool nightShiftReady;

  /// #1343 — the SAME resume as structured data (GET /resume/document), a
  /// best-effort UPGRADE over [resumeText]. Null when the server has none yet
  /// OR the fetch failed — the screen must fall back to parsing [resumeText]
  /// on null, never treat it as "no resume".
  final ResumeDocument? document;

  @override
  List<Object?> get props =>
      <Object?>[status, resumeText, nightShiftReady, document];
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
      // over the resume text already on screen.
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
    } on ProfileIncompleteFailure catch (_) {
      if (isClosed) return;
      // #1371 — form handover skips extraction, so the profile may not exist
      // yet. Trigger extraction (idempotent — a normal-profiled worker's call
      // dedupes server-side) and retry once. A second failure surfaces as
      // noProfile so the worker is never stuck in a loop.
      try {
        await _profileRepo.extractProfile();
      } catch (_) {
        // Extraction failed or timed out — fall through to noProfile.
      }
      if (isClosed) return;
      try {
        final String retryText = await _repo.generateResume(force: false);
        if (isClosed) return;
        if (!_isBlank(retryText)) {
          emit(ResumeState(
            status: ResumeStatus.ready,
            resumeText: retryText,
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
  Future<void> showGenerated(String text) async {
    // #820 — the Building screen can hand off an empty body; never present it as a
    // ready resume. Fail closed to the retry view.
    if (_isBlank(text)) {
      emit(const ResumeState(status: ResumeStatus.failed));
      return;
    }
    // Show the text immediately; load the night-shift pref + the structured
    // document in the background.
    emit(ResumeState(status: ResumeStatus.ready, resumeText: text));
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
    final ResumeDocument? reloaded = await _loadDocument();
    if (isClosed) return;
    emit(ResumeState(
      status: state.status,
      resumeText: state.resumeText,
      nightShiftReady: state.nightShiftReady,
      document: reloaded ?? state.document,
    ));
  }
}
