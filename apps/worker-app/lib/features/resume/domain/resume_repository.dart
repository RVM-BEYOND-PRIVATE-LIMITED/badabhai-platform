/// Resume boundary. Generates the worker's resume from the confirmed profile,
/// stores the resume id in the session, and returns the resume text.
/// Implementations throw a [Failure] on error.
abstract interface class ResumeRepository {
  Future<String> generateResume();
}
