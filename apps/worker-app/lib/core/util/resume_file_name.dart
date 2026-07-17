// Deterministic, no-LLM file name for a worker's OWN downloaded resume PDF.
//
// The worker's full name here is the §2-approved own-session self-read
// (GET /workers/me/resume-fields → full_name). It is used ONLY to label the file
// the worker saves to their own device — it NEVER enters resume generation, an
// LLM prompt, events, ai_jobs, or any log (CLAUDE.md §2). Keeping the naming
// client-side + deterministic is exactly the "done later so no LLM is involved"
// constraint: the name is applied at download time, entirely outside the AI path.

/// The generic name used when the worker has no usable name on file (name unset,
/// or nothing filename-safe survived sanitisation). Also the value the download
/// button starts with, before the name prefetch resolves.
const String kFallbackResumeFileName = 'BadaBhai_Resume.pdf';

/// Upper bound on the NAME portion (before `_RESUME.pdf`) so a pathological
/// long name can't push the file name past the ~255-byte MediaStore/filesystem
/// ceiling.
const int _kMaxNameBaseLength = 120;

/// Characters illegal in an Android/MediaStore file name (path separators,
/// reserved glyphs, control chars). Unicode LETTERS are deliberately NOT in this
/// set: MediaStore stores UTF-8 display names, so a name in an Indic script (e.g.
/// Devanagari) still labels the file correctly rather than being blanked out.
final RegExp _unsafeFileNameChars = RegExp(r'[\\/:*?"<>|\x00-\x1F]');

/// Leading/trailing dots or whitespace on a token — a leading dot would make a
/// hidden file, a trailing dot is noise (e.g. "Md." → "MD").
final RegExp _edgeDotsOrSpace = RegExp(r'^[.\s]+|[.\s]+$');

/// Builds the download file name for a worker's own resume from [fullName],
/// "all words" style: EVERY whitespace-separated token of the name, uppercased
/// and joined with `_`, then `_RESUME.pdf`.
///
///   "Ram Kumar Sharma" → "RAM_KUMAR_SHARMA_RESUME.pdf"
///   "Ramesh"           → "RAMESH_RESUME.pdf"
///   null / "" / "   "  → [kFallbackResumeFileName]
///
/// Pure + deterministic (no I/O, no LLM). Filesystem-unsafe characters are
/// stripped; if nothing usable remains it falls back to [kFallbackResumeFileName].
String resumeDownloadFileName(String? fullName) {
  final String raw = (fullName ?? '').trim();
  if (raw.isEmpty) return kFallbackResumeFileName;

  final List<String> tokens = raw
      .split(RegExp(r'\s+'))
      .map((String t) => t
          .toUpperCase()
          .replaceAll(_unsafeFileNameChars, '')
          .replaceAll(_edgeDotsOrSpace, ''))
      .where((String t) => t.isNotEmpty)
      .toList();
  if (tokens.isEmpty) return kFallbackResumeFileName;

  String base = tokens.join('_');
  if (base.length > _kMaxNameBaseLength) {
    // Trim to the cap, then drop any dangling separator the cut left behind.
    base = base.substring(0, _kMaxNameBaseLength).replaceAll(RegExp(r'_+$'), '');
    if (base.isEmpty) return kFallbackResumeFileName;
  }
  return '${base}_RESUME.pdf';
}
