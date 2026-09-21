/// The post-completion résumé menu's stable `option_key`s (backend
/// `apps/api/src/chat/resume-menu.ts`, ADR-0042 / issue #1566).
///
/// An ended chat session answers every message with this menu (`session_ended:
/// true`); the SERVER owns the copy and the client routes on these keys, NEVER
/// on the labels. The keys and the six section keys are byte-checked against the
/// server source by `resume_menu_parity_test.dart`, so the two halves cannot
/// drift the way a hand-kept list would.
library;

/// The root menu: "Apna resume edit karein".
const String kResumeMenuEditKey = 'resume_edit';

/// The root menu: "Apna resume dobara banayein".
const String kResumeMenuRedoKey = 'resume_redo';

/// The redo submenu: "Resume upload karein".
const String kResumeMenuUploadKey = 'resume_upload';

/// The redo submenu: "Chat se resume banayein".
const String kResumeMenuChatCreateKey = 'resume_chat_create';

/// Prefix of the six `section_*` edit keys (`section_general_info`, …).
const String kResumeMenuSectionPrefix = 'section_';

/// The piloted per-section walk: "Technical Skills" re-asks only the
/// capability questions on the EXISTING trade-form pages
/// (`trade_form_section_walk.dart`) instead of opening the generic Resume
/// Edit. Other sections keep the Edit-surface route until their own walk
/// lands. Pinned against the server source by the parity test like the rest.
const String kResumeMenuTechnicalSkillsKey = 'section_technical_skills';

/// What tapping a served menu option should DO.
enum ResumeMenuAction {
  /// Ordinary answer / a menu-navigation turn the SERVER must resolve (the root
  /// `resume_edit` / `resume_redo` chips): submit the label through the chat and
  /// let the server serve the next menu. This is also the default for every
  /// non-menu option, so no ordinary chip changes behaviour.
  sendToServer,

  /// `resume_upload` → the existing résumé-import screen.
  openResumeUpload,

  /// `resume_chat_create` → mint a genuinely NEW chat session and reset the
  /// transcript (the old one is preserved server-side).
  startFreshChat,

  /// A `section_*` chip → the Resume tab's Edit surface.
  openSection,
}

/// Classify a served `option_key`. Anything that is not a menu key falls through
/// to [ResumeMenuAction.sendToServer] — i.e. exactly today's behaviour for an
/// ordinary chip, so this can never change a mid-interview turn.
ResumeMenuAction resumeMenuActionFor(String optionKey) {
  switch (optionKey) {
    case kResumeMenuUploadKey:
      return ResumeMenuAction.openResumeUpload;
    case kResumeMenuChatCreateKey:
      return ResumeMenuAction.startFreshChat;
    case kResumeMenuEditKey:
    case kResumeMenuRedoKey:
      // The server owns the next menu (six sections, or upload-vs-chat), so the
      // tap is submitted as an ordinary chat message and the reply is rendered.
      return ResumeMenuAction.sendToServer;
    default:
      return optionKey.startsWith(kResumeMenuSectionPrefix)
          ? ResumeMenuAction.openSection
          : ResumeMenuAction.sendToServer;
  }
}
