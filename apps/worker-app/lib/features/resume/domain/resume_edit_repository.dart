import 'resume_safe_fields.dart';

/// Resume safe-field edit boundary. Loads the worker-editable fields and
/// persists changes. Implementations throw a [Failure] on error.
abstract interface class ResumeEditRepository {
  Future<ResumeSafeFields> load();

  /// Persists [fields]. Returns TRUE when the worker's NAME actually changed.
  ///
  /// The name is baked into the resume at generation time, so an edited spelling
  /// only reaches the resume (and the #398 download file name) after a
  /// regenerate. The implementation already knows this — it PATCHes the name
  /// only when it differs from the loaded one — so it reports it rather than
  /// making the caller diff again, and the preview regenerates ONLY on a real
  /// name change (an unconditional regenerate would burn the 5/day cap).
  Future<bool> save(ResumeSafeFields fields);
}
