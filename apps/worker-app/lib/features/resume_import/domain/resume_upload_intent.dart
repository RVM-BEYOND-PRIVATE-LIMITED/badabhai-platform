/// Markers carried as go_router `extra` to `Routes.resumeUpload`, saying which
/// road the worker took to get there.
///
/// Marker TYPES rather than bools, so a stray `extra` from some other caller
/// can never accidentally mean "auto-upload" (the same rule
/// `ConsentReturnIntent` follows).
library;

/// The worker already chose "Resume upload karein" in the CHAT's résumé
/// prompt: the upload screen opens the file picker straight away instead of
/// asking the same question a second time.
///
/// It also means "a prompt is standing open behind this screen": a completed
/// attempt raises `ResumeImportSignal`, which answers that prompt. That second
/// meaning is why no other caller may send it — see [ResumeUploadDirectIntent].
class ResumeUploadAutoIntent {
  const ResumeUploadAutoIntent();
}

/// The worker tapped an explicit "Resume upload karein" ENTRY outside the chat
/// — the Résumé tab, "Mere resume" or the Profile tab. The upload screen opens
/// the file picker straight away, exactly as for [ResumeUploadAutoIntent].
///
/// A SEPARATE TYPE, NOT A REUSE OF [ResumeUploadAutoIntent]: no chat prompt is
/// standing open behind an entry, so a completed attempt must raise NO
/// `ResumeImportSignal`. A signal raised here would sit unconsumed until some
/// LATER prompt appeared, and answer that one on the worker's behalf.
///
/// It also decides where the worker lands afterwards: the Bada Bhai TAB, not
/// the onboarding chat (owner ruling 2026-10-16), and the router keeps the push
/// out of the worker's durable onboarding step.
class ResumeUploadDirectIntent {
  const ResumeUploadDirectIntent();
}
