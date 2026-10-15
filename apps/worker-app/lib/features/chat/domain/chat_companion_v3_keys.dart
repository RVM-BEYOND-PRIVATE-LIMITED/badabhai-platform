/// The Bada Bhai chat's v3 chip keys (ADR-0055, #2275 / #2276) — mirrored from
/// the server's `apps/api/src/chat-companion/companion-v3-keys.ts`.
///
/// A file of their own, like the server's: the existing parity tests pin
/// `companion-keys.ts` and `resume-menu.ts` at exactly four keys each, so these
/// two have their own parity pair (`chat_companion_v3_test.dart`, #2282) —
/// keys AND labels, byte for byte.
library;

/// The companion's redo-menu form road: "Form se resume banayein". Routed by
/// the app to the FULL trade-form walk — never posted to the server.
const String kResumeMenuFormCreateKey = 'resume_form_create';

/// The label the server serves with [kResumeMenuFormCreateKey]. The app draws
/// whatever label the server sends; this mirror exists so the parity test can
/// catch the two drifting apart.
const String kResumeMenuFormCreateLabel = 'Form se resume banayein';

/// "Resume download karein": save the worker's current résumé PDF, exactly as
/// the in-chat "Resume download" tile does — never posted to the server. The
/// server offers it only when the current résumé's PDF is rendered.
const String kCompanionResumeDownloadKey = 'companion_resume_download';

/// The label the server serves with [kCompanionResumeDownloadKey] — mirrored for
/// the parity test, like [kResumeMenuFormCreateLabel].
const String kCompanionResumeDownloadLabel = 'Resume download karein';
