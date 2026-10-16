import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/util/resume_file_name.dart';
import '../../../core/util/transient_retry.dart';
import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';

// The pieces every in-app résumé PDF download shares — the Resume tab's
// Download / Share buttons and the Bada Bhai chat's "Resume download" tile —
// so a worker gets the same file name and the same patience with a render
// that is still running, wherever they tap.

/// How many times the download resolver re-checks a "still rendering" 409, and
/// how long it waits between checks.
///
/// 50 x 1500ms = 75s of waiting. The budget MUST outlast the server's own render
/// timeout — PdfRenderer.RENDER_TIMEOUT_MS is 20s — PLUS the BullMQ pickup latency,
/// the Storage upload, and (crucially) ONE retry cycle, because the FIRST-EVER
/// render is a COLD WeasyPrint start (Python + fonts load on first spawn) and can
/// legitimately run to ~20s, occasionally timing out once and succeeding on the
/// BullMQ retry (attempts:3, exponential backoff). The old 30s budget barely
/// cleared a single 20s render, so a fresh-registration first download routinely
/// hit "taiyaar ho rahi hai" while the render was still perfectly healthy — the
/// worker just had to tap again once it finished. 75s covers the cold first render
/// end-to-end. Most renders finish in the first ~10s, so the typical wait is short;
/// this only extends the SLOW tail rather than the common case.
///
/// Still BOUNDED, because it must be: when rendering is disabled server-side the
/// row stays 'pending' forever, and the worker has to get the honest "taiyaar ho
/// rahi hai" rather than an endless spinner.
const int _kReadyMaxAttempts = 50;
const Duration _kReadyPollInterval = Duration(milliseconds: 1500);

/// Button label while the PDF is still rendering — honest progress, not an
/// error. The worker is not waiting on their phone; they are waiting on a render.
const String kResumePreparingLabel = 'PDF taiyaar ho rahi hai…';

/// The saved/shared file name derived from the worker's OWN name (§2 self-read,
/// no LLM — see [resumeDownloadFileName]), or [kFallbackResumeFileName] when the
/// name cannot be read.
///
/// NEVER throws: a name-fetch failure (offline / session gone / unset name / a
/// graph with no [ResumeEditRepository]) must not cost the worker their PDF —
/// the name on the file is a nicety, not a precondition. Shared by every
/// download surface so the document a factory owner receives on WhatsApp carries
/// the same NAME_..._RESUME.pdf the Downloads folder does.
Future<String> loadResumeDownloadFileName() async {
  if (!locator.isRegistered<ResumeEditRepository>()) {
    return kFallbackResumeFileName;
  }
  try {
    final ResumeSafeFields fields = await locator<ResumeEditRepository>()
        .load();
    return resumeDownloadFileName(fields.displayName);
  } catch (_) {
    return kFallbackResumeFileName;
  }
}

/// Mints a signed résumé PDF url through [mint], tolerating the SHORT "still
/// rendering" window.
///
/// A generate resets the row to render_status 'pending' and re-enqueues the
/// render, so right after an edit-driven regenerate the first download
/// legitimately 409s (→ [ResumeNotReadyFailure]). One-shotting that told the
/// worker their download failed when it was simply seconds early. Poll briefly
/// instead — the caller's button stays in its loading state, so this reads as
/// "checking…" rather than a stall. [onPreparing] fires the first time a 409 is
/// seen so the button can say WHY it is waiting.
///
/// Deliberately BOUNDED and short: when rendering is disabled server-side the
/// PDF never arrives, and the worker must get the honest "taiyaar ho rahi hai"
/// rather than an indefinite spinner. Only the not-ready case and a transient
/// blip retry — every other failure surfaces immediately, as its typed
/// [Failure], so `downloadSignedPdf` can name the real cause.
///
/// [renderStatus] — when the caller can READ the render's state (`'pending' |
/// 'rendered' | 'failed'`, null when unknown), the wait after a "still
/// rendering" 409 runs on THAT read, and [mint] is called again only once it
/// stops saying pending. Every mint is charged to the server's per-IP hourly
/// download cap (20 an hour), a 409 included, so re-minting every 1.5s spent
/// the whole allowance on ONE tap at a slow render and then refused every
/// download — ready ones too — with "Bahut requests". The read is not capped.
/// A read that says failed ends the wait with [ResumePdfUnavailableFailure];
/// one that cannot answer (null, or a throw) mints again, as before.
Future<String?> pollSignedResumeUrl({
  required Future<String?> Function() mint,
  required void Function() onPreparing,
  Future<String?> Function()? renderStatus,
}) async {
  // True once a "still rendering" 409 has handed the wait to [renderStatus].
  bool waitOnStatus = false;
  for (int attempt = 0; attempt < _kReadyMaxAttempts; attempt++) {
    final bool lastAttempt = attempt == _kReadyMaxAttempts - 1;
    if (waitOnStatus) {
      final String? status = await _readRenderStatus(renderStatus!);
      if (status == 'failed') throw const ResumePdfUnavailableFailure();
      // Still rendering: wait again without spending a mint. The LAST attempt
      // always mints, so a render that never lands still ends on the server's
      // own honest 409.
      if (status == 'pending' && !lastAttempt) {
        await Future<void>.delayed(_kReadyPollInterval);
        continue;
      }
    }
    try {
      return await mint();
    } on ResumeNotReadyFailure {
      if (lastAttempt) rethrow;
      // Say WHY the wait is happening — the PDF is rendering, nothing is wrong.
      onPreparing();
      waitOnStatus = renderStatus != null;
      await Future<void>.delayed(_kReadyPollInterval);
    } catch (error) {
      // A transient 5xx / transport blip on the mint is the OTHER reason a
      // first tap failed and a second worked: only the 409 was retried, so a
      // 500 fell straight through to "Server error (500)". Ride it out on the
      // SAME bounded budget rather than nesting a second retry loop inside
      // this one (which would multiply 20 attempts into 60 requests).
      //
      // Deliberately does NOT call onPreparing: the PDF is not rendering, the
      // server hiccuped, and claiming otherwise would be a lie.
      if (lastAttempt || !isTransientFailure(error)) rethrow;
      await Future<void>.delayed(_kReadyPollInterval);
    }
  }
  return null; // unreachable: the last attempt either returns or rethrows.
}

/// [read], with every failure read as "unknown" — the poll then mints, as it
/// always did. A status read must never be the thing that fails a download.
Future<String?> _readRenderStatus(Future<String?> Function() read) async {
  try {
    return await read();
  } catch (_) {
    return null;
  }
}
