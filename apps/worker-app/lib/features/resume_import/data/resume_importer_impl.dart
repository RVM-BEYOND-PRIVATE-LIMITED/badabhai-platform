import '../../../core/api/api_client.dart';
import '../../../core/observability/crash_reporter.dart';
import '../../../core/session/session_repository.dart';
import '../../../core/storage/signed_object_put.dart';
import '../domain/resume_document.dart';
import '../domain/resume_importer.dart';

/// Reports a caught, NON-FATAL error. The same seam `TradeFormRepositoryImpl`
/// uses, and for the same reason: it makes "this failure was REPORTED, not
/// swallowed" unit-testable without a live Firebase.
typedef NonFatalReporter = void Function(
  Object error,
  StackTrace stack, {
  required String reason,
});

void _recordNonFatal(Object error, StackTrace stack, {required String reason}) =>
    CrashReporter.recordNonFatal(error, stack, reason: reason);

/// REAL résumé import: mint → PUT → register → poll → a routing decision.
///
/// ── IT NEVER THROWS, AND THAT IS THE WHOLE POINT ────────────────────────────
///
/// Ruling D9: "say so plainly and continue in Hinglish. Never a dead end." A
/// thrown exception here would surface as a generic error screen at the single
/// step of onboarding where a worker has invested a document and nothing else
/// yet — so every failure, without exception, comes back as a
/// [ResumeImportOutcome] the screen can render honestly and walk away from.
/// The catch-all at the bottom is deliberate, not lazy.
///
/// ── THE BYTES ARE NOT OURS TO KEEP ──────────────────────────────────────────
///
/// The document is passed in already in memory, PUT once, and never written to
/// disk or logged by us. Ruling D6 keeps the UPLOADED copy permanently — that
/// is the server's copy, under the worker's erasure right. This class holds
/// nothing after it returns.
///
/// ── DORMANCY IS CHECKED BY DOING, NOT BY ASKING ─────────────────────────────
///
/// There is no capability probe. `RESUME_UPLOADS_BUCKET` being unset shows up
/// as a 503 from the MINT, which is before any byte leaves the device, so the
/// honest [ResumeImportUnavailable] costs the worker one small request and no
/// data. A probe on screen entry would instead add a request to a screen that
/// must make none (see `ResumeUploadScreen`).
class ResumeImporterImpl implements ResumeImporter {
  ResumeImporterImpl({
    required ApiClient api,
    required SessionRepository session,
    SignedObjectPut? put,
    Duration pollInterval = defaultPollInterval,
    Duration pollBudget = defaultPollBudget,
    NonFatalReporter reportNonFatal = _recordNonFatal,
  })  : _api = api,
        _session = session,
        _put = put ?? SignedObjectPut(),
        _pollInterval = pollInterval,
        _pollBudget = pollBudget,
        _report = reportNonFatal;

  /// Gap between polls of `GET /profiling/resume-import/:id`.
  static const Duration defaultPollInterval = Duration(seconds: 2);

  /// How long we wait for a parse before continuing WITHOUT it.
  ///
  /// The read is a download, possibly a rasterise, possibly local OCR, then one
  /// model call — tens of seconds on a photographed sheet, and the worker is
  /// holding a phone. 90s is generous for that and still short of the point
  /// where he decides the app is broken. Running out is NOT an error: he goes
  /// into the chat, and whatever the parse eventually finds is already the
  /// server's to use.
  static const Duration defaultPollBudget = Duration(seconds: 90);

  final ApiClient _api;
  final SessionRepository _session;
  final SignedObjectPut _put;
  final Duration _pollInterval;
  final Duration _pollBudget;
  final NonFatalReporter _report;

  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument document) async {
    final String? token = _session.sessionToken;
    // Fail CLOSED, and quietly: there is no anonymous upload, and a worker
    // without a session is a bug upstream rather than something he can fix.
    if (token == null) return const ResumeImportFailed();

    // Belt and braces behind the picker's own check. The server is the
    // authority on the cap, but spending a worker's uplink to be told no is
    // not something to do twice.
    if (document.sizeBytes <= 0 ||
        document.sizeBytes > kResumeUploadMaxBytes) {
      return const ResumeImportFailed();
    }

    try {
      // (1) MINT. A 503 here is the dormant feature, and it is the only status
      // that means something other than "this did not work".
      final SignedUploadTicket ticket;
      try {
        ticket = await _api.createResumeUploadUrl(
          mime: document.kind.mime,
          authToken: token,
        );
      } on ApiException catch (error) {
        if (error.statusCode == 503) return const ResumeImportUnavailable();
        rethrow;
      }

      // (2) THE BYTES, straight to Storage. The shared PUT — never a second
      // uploader (#1499). `ticket.uploadUrl` is a bearer credential and is not
      // logged here or anywhere below.
      await _put.send(
        uploadUrl: ticket.uploadUrl,
        bytes: document.bytes,
        contentType: document.kind.mime,
        what: 'résumé',
      );

      // (3) REGISTER. Idempotent on the key server-side, so a retry of a
      // confirm whose response we lost returns the original row.
      final ResumeImportDto registered;
      try {
        registered = await _api.confirmResumeImport(
          storagePath: ticket.storagePath,
          authToken: token,
        );
      } on ApiException catch (error) {
        if (error.statusCode == 503) return const ResumeImportUnavailable();
        rethrow;
      }

      // (4) POLL until the server stops changing its mind, or until we run out
      // of patience — which is a continue, not a failure.
      final ResumeImportDto? settled = await _pollToTerminal(
        importId: registered.importId,
        first: registered,
        token: token,
      );
      if (settled == null || settled.hasFailed) return const ResumeImportFailed();

      return switch (settled.route) {
        ResumeImportRoute.form =>
          ResumeImportRoutedToForm(formKind: settled.formKind),
        // `parsed` with a null route should not happen — the server sets both
        // together — but guessing `form` on a null would send a worker to a
        // screen that has nothing to show him. Chat is the honest default.
        ResumeImportRoute.chat || null => const ResumeImportRoutedToChat(),
      };
    } catch (error, stack) {
      // REPORTED, NOT SWALLOWED — and then the worker continues anyway. The
      // reason is STATIC and PII-FREE: no filename, no storage key, no url.
      _report(error, stack, reason: 'resume_import_failed');
      return const ResumeImportFailed();
    }
  }

  /// Polls until the row is terminal, or null if the budget ran out.
  ///
  /// A 404 stops IMMEDIATELY rather than retrying: the route answers 404 for
  /// both not-found and not-yours, so it can never become a 200 by waiting —
  /// retrying it would burn the whole budget on a row that does not exist.
  Future<ResumeImportDto?> _pollToTerminal({
    required String importId,
    required ResumeImportDto first,
    required String token,
  }) async {
    if (first.isTerminal) return first;

    final Stopwatch elapsed = Stopwatch()..start();
    while (elapsed.elapsed < _pollBudget) {
      await Future<void>.delayed(_pollInterval);
      final ResumeImportDto current;
      try {
        current = await _api.getResumeImport(
          importId: importId,
          authToken: token,
        );
      } on ApiException catch (error) {
        if (error.statusCode == 404) return null;
        // A transient 5xx or a dropped connection mid-poll is exactly what the
        // budget is for: keep waiting rather than declaring a parse dead
        // because one read failed.
        continue;
      }
      if (current.isTerminal) return current;
    }
    return null;
  }
}

/// MOCK résumé import: no network, no bytes moved — mock mode's guarantee.
///
/// Mirrors the DORMANT server by default ([ResumeImportUnavailable]), because
/// that is production today. Set [outcome] in a test or a dev build to walk any
/// other branch.
class MockResumeImporter implements ResumeImporter {
  MockResumeImporter({this.outcome = const ResumeImportUnavailable()});

  ResumeImportOutcome outcome;

  @override
  Future<ResumeImportOutcome> importResume(
    PickedResumeDocument document,
  ) async {
    await Future<void>.delayed(const Duration(milliseconds: 400));
    return outcome;
  }
}
