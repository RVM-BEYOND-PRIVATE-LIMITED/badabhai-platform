/// Marker carried as go_router `extra` when the worker already chose "Resume
/// upload karein" in the chat's résumé prompt: the upload screen opens the
/// file picker straight away instead of asking the same question a second
/// time.
///
/// A marker TYPE rather than a bool, so a stray `extra` from some other caller
/// can never accidentally mean "auto-upload" (the same rule
/// `ConsentReturnIntent` follows).
library;

class ResumeUploadAutoIntent {
  const ResumeUploadAutoIntent();
}
