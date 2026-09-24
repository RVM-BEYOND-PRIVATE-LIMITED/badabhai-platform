import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/resume_repository.dart';

class ResumeRepositoryImpl implements ResumeRepository {
  ResumeRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<String> generateResume({bool force = false}) async {
    final String? workerId = _session.workerId;
    final String? token = _session.sessionToken;
    if (workerId == null || token == null) {
      throw const UnauthorizedFailure();
    }

    String? profileId = _session.profileId;

    // Resolve the profile and REUSE an existing resume — on EVERY open, not only
    // when profileId happens to be null.
    //
    // The reuse short-circuit used to live inside `if (profileId == null)`, and
    // that block set profileId itself. So it fired at most once per session:
    // every later Resume-tab open fell straight through to POST /resume/generate.
    // Server-side that is createInitial(overwrite: true) — it resets
    // render_status to 'pending' and pdf_storage_key to null. The app was
    // destroying its own rendered PDF on each open (a self-inflicted 409 on the
    // very next download) and spending the worker's 5/day generate cap to do it
    // (then 429). Reuse is now the default and generate the exception.
    if (!force) {
      try {
        final WorkerProfileBundle bundle = await _api.getWorkerProfile(
          workerId: workerId,
          authToken: token,
        );
        if (!bundle.hasProfile) {
          throw const ProfileIncompleteFailure();
        }
        _session.setProfile(bundle.profileId!);
        profileId = bundle.profileId;
        if (bundle.hasResume &&
            await _resumeBelongsToProfile(
              resumeId: bundle.resumeId!,
              profileId: bundle.profileId!,
            )) {
          _session.setResume(bundle.resumeId!);
          return bundle.resumeText!;
        }
      } on Failure {
        rethrow;
      } catch (error) {
        throw mapError(error);
      }
    } else if (profileId == null) {
      // Deliberate rebuild, but this session never ran profiling — resolve the
      // profile id WITHOUT taking the reuse branch, or the stale cached text
      // would be returned and the regenerate silently skipped (F3).
      try {
        final WorkerProfileBundle bundle = await _api.getWorkerProfile(
          workerId: workerId,
          authToken: token,
        );
        if (!bundle.hasProfile) {
          throw const ProfileIncompleteFailure();
        }
        _session.setProfile(bundle.profileId!);
        profileId = bundle.profileId;
      } on Failure {
        rethrow;
      } catch (error) {
        throw mapError(error);
      }
    }

    try {
      final ResumeResult result = await _api.generateResume(
        workerId: workerId,
        profileId: profileId!,
        authToken: token,
      );
      _session.setResume(result.resumeId);
      return result.resumeText;
    } catch (error) {
      throw mapError(error);
    }
  }

  /// #1690 — does [resumeId] actually belong to [profileId]?
  ///
  /// A RETURNING worker who confirms a NEW profile still has their PREVIOUS
  /// profile's resume on `GET /workers/me/profile`, and the reuse branch above
  /// used to hand it straight back: the Building screen then finished on the
  /// old profile's content. The history rows carry `profile_id`, so the
  /// question has a real answer now.
  ///
  /// FAILS OPEN, deliberately, and this is the load-bearing part: when the
  /// history route is absent, empty, or simply does not mention this resume,
  /// the answer is TRUE — today's behaviour, byte for byte. The alternative
  /// (fail closed → regenerate) would re-open the F2/F3 wound this reuse
  /// branch exists to fix: a `POST /resume/generate` is `createInitial(
  /// overwrite: true)` server-side, which resets `render_status` to pending,
  /// nulls the pdf key (a self-inflicted 409 on the very next download) and
  /// spends one of the worker's five daily generates. Only a row that EXISTS
  /// and NAMES A DIFFERENT PROFILE is allowed to refuse the reuse.
  Future<bool> _resumeBelongsToProfile({
    required String resumeId,
    required String profileId,
  }) async {
    final ResumeHistory history = await loadResumeHistory();
    // #1689 × #1690 — an accepted chat update is ALREADY generating a resume
    // for the new profile, server-side. The ids legitimately disagree for that
    // whole window, and refusing the reuse here would answer it with a
    // client-side `POST /resume/generate`: a duplicate history entry for work
    // already in flight, which #1689 forbids in as many words, plus one of the
    // worker's five daily generates. Reuse the old text until the new entry
    // lands; #1688 is what replaces it on screen.
    if (history.pendingUpdate?.isInProgress ?? false) return true;
    for (final ResumeHistoryItem item in history.items) {
      if (item.resumeId != resumeId) continue;
      final String? owner = item.profileId;
      // A row with no profile_id is a legacy row: it cannot disagree.
      if (owner == null || owner.isEmpty) return true;
      return owner == profileId;
    }
    return true;
  }

  @override
  Future<String> resumeDownloadUrl() async {
    final String? resumeId = _session.resumeId;
    final String? token = _session.sessionToken;
    if (resumeId == null || token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      final ResumeDownload dl = await _api.downloadResume(
        resumeId: resumeId,
        authToken: token,
      );
      return dl.url;
    } on ApiException catch (e) {
      // 409 on the download route specifically means the PDF isn't rendered yet
      // (render pending / not enabled) — surface an honest "taiyaar ho rahi hai"
      // instead of the generic server error the global mapper would produce.
      if (e.statusCode == 409) {
        throw const ResumeNotReadyFailure();
      }
      throw mapError(e);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<String> resumeDownloadUrlFor(String resumeId) async {
    final String? token = _session.sessionToken;
    if (resumeId.isEmpty || token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      final ResumeDownload dl = await _api.downloadResume(
        resumeId: resumeId,
        authToken: token,
      );
      return dl.url;
    } on ApiException catch (e) {
      // Same 409 reading as [resumeDownloadUrl]: the pdf is not rendered yet,
      // which is a wait, not a failure. An OLDER history entry can sit in this
      // state too — a re-render was queued and has not landed.
      if (e.statusCode == 409) {
        throw const ResumeNotReadyFailure();
      }
      throw mapError(e);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> reportSharedFor(String resumeId, String channel) async {
    final String? token = _session.sessionToken;
    if (resumeId.isEmpty || token == null) return;
    try {
      await _api.shareResume(
        resumeId: resumeId,
        channel: channel,
        authToken: token,
      );
    } catch (_) {
      // Swallowed, exactly as [reportShared] swallows it, and for the same
      // reason: this fires AFTER a share the worker already completed.
    }
  }

  /// Latched once `GET /resume/history` proves absent, so the app probes a
  /// server that does not have the route AT MOST ONCE PER RUN.
  ///
  /// This is not an optimisation, it is damage control. On a server built
  /// before ADR-0043 the literal path `/resume/history` falls through to
  /// `@Get(":id")`, which is behind `InternalServiceGuard`, so the answer is a
  /// **401** — and [ApiClient] treats a 401 on a worker-scoped call as "the
  /// bearer may be stale" and spends one token REFRESH before surfacing it.
  /// Polling that every tab focus would burn a refresh per visit for a feature
  /// the server does not have.
  ///
  /// An INSTANCE field, not a static: this repository is a
  /// `registerLazySingleton`, so one instance already IS one app run — and a
  /// static would leak the latch from one test into every test after it in the
  /// same isolate.
  bool _historyRouteAbsent = false;

  @override
  Future<ResumeHistory> loadResumeHistory() async {
    if (_historyRouteAbsent) return ResumeHistory.empty;
    final String? token = _session.sessionToken;
    if (token == null) return ResumeHistory.empty;
    try {
      return await _api.getResumeHistory(authToken: token);
    } on ApiException catch (e) {
      // 404 = the route is genuinely missing. 401/403 = this build is talking
      // to a server whose `/resume/:id` catch-all swallowed the path (see
      // [_historyRouteAbsent]) or whose consent gate refused it. All three mean
      // the same thing to the Resume tab: there is no history to show.
      //
      // Swallowing a 401 HERE is safe precisely because this read is additive:
      // the tab's REAL resume read runs on the same session and surfaces a
      // genuine expiry itself, honestly, with the re-login path the app
      // already has. Hiding one optional section is never the thing that
      // should tell a worker their session died.
      if (e.statusCode == 404 || e.statusCode == 401 || e.statusCode == 403) {
        _historyRouteAbsent = true;
      }
      return ResumeHistory.empty;
    } catch (_) {
      // Offline, 5xx, a malformed body: the section simply does not draw. NOT
      // latched — a transient failure must not cost the worker the feature for
      // the rest of the run.
      return ResumeHistory.empty;
    }
  }

  @override
  Future<void> reportShared(String channel) async {
    final String? resumeId = _session.resumeId;
    final String? token = _session.sessionToken;
    // No resume yet, or no session — nothing to report. Silent by contract:
    // this is best-effort telemetry fired after a share that already happened.
    if (resumeId == null || token == null) return;
    try {
      await _api.shareResume(
        resumeId: resumeId,
        channel: channel,
        authToken: token,
      );
    } catch (_) {
      // Swallow EVERY error (offline, 4xx/5xx, session gone). A failed
      // `resume.shared` report must never cost the worker the share they made.
    }
  }

  @override
  Future<ResumeDocumentSnapshot> loadResumeDocument() async {
    final String? token = _session.sessionToken;
    // No session → nothing to fetch. Silent by contract (see the interface
    // doc): this is a best-effort UPGRADE over resume_text, never a
    // precondition for it.
    if (token == null) return const ResumeDocumentSnapshot();
    try {
      final ResumeDocumentResponse response = await _api.getResumeDocument(
        authToken: token,
      );
      // `render_status` rides along from the same response — the resume tab
      // gates its READY pill on it rather than on "there is resume text"
      // (R6). A server that does not send it leaves it null, and null is not
      // ready.
      return ResumeDocumentSnapshot(
        document: response.document,
        renderStatus: response.renderStatus,
        renderedAt: response.renderedAt,
      );
    } catch (_) {
      // Swallow EVERY error — a 404 ("no resume row yet"), a network blip, or
      // any other failure must never cost the worker their resume tab. The
      // existing resume_text path (already fetched via generateResume/reuse)
      // stays authoritative; only a clean 2xx `document` is ever drawn, and
      // an unknown render status never claims READY.
      return const ResumeDocumentSnapshot();
    }
  }

  @override
  Future<void> setEmploymentDescriptionSource(
    String employmentId, {
    required bool ownWords,
  }) async {
    final String? token = _session.sessionToken;
    if (token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      await _api.setEmploymentDescriptionSource(
        employmentId: employmentId,
        ownWords: ownWords,
        authToken: token,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> setAnswerTextSource(
    String attributeKey, {
    required bool ownWords,
  }) async {
    final String? token = _session.sessionToken;
    if (token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      await _api.setAnswerTextSource(
        attributeKey: attributeKey,
        ownWords: ownWords,
        authToken: token,
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}
