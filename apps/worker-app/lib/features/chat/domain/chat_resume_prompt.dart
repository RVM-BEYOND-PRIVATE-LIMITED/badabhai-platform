/// The in-chat résumé question asked once the identity intake has captured
/// the worker's name (first + surname).
///
/// Replaces the retired `/resume-upload` two-door screen: instead of a separate
/// step between `/name` and `/chat`, the chat itself asks, right after the
/// server confirms the name steps are done.
library;

/// The bot bubble asked once the name is complete.
const String kResumePromptText =
    'Resume hai aapke paas? Upload karein to aadhi jaankari apne aap bhar jaayegi.';

/// `resume_upload` — MUST stay byte-identical to the post-completion menu's
/// upload key (`kResumeMenuUploadKey`): the chat screen routes that key to the
/// existing résumé-import screen and never submits it.
const String kResumePromptUploadKey = 'resume_upload';

/// Client-only key for "I don't have one". Never sent to the server: the
/// screen intercepts it and the bloc dismisses the prompt locally, so the
/// label never lands in the transcript that feeds extraction.
const String kResumePromptNoResumeKey = 'no_resume';

/// Chip labels — the same words the retired two-door screen used.
const String kResumePromptUploadLabel = 'Resume upload karein';
const String kResumePromptNoResumeLabel = 'Mere paas resume nahi hai';
