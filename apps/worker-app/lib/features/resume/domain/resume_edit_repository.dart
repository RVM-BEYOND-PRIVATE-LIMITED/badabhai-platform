import 'resume_safe_fields.dart';

/// Resume safe-field edit boundary. Loads the worker-editable fields and
/// persists changes. Implementations throw a [Failure] on error.
abstract interface class ResumeEditRepository {
  Future<ResumeSafeFields> load();
  Future<void> save(ResumeSafeFields fields);
}
