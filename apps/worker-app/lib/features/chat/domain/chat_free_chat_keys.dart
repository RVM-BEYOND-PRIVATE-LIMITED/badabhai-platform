/// ADR-0051 §5.1 — the profiling-stage free chat's CHIP KEYS, and the only
/// thing that tells this app which mode the chat is in.
///
/// The server owns the copy and the client routes on these keys, NEVER on the
/// labels — the same contract as the companion's (`chat_companion_keys.dart`)
/// and the résumé menu's. The server declares them in
/// `apps/api/src/profiling/free-chat/free-chat.copy.ts`
/// (`FREE_CHAT_START_KEY` / `_LATER_KEY` / `_RESUME_KEY`); until that module is
/// on `main` the byte pin in `chat_free_chat_keys_test.dart` reads them out of
/// ADR-0051 itself, which names all three and IS merged.
///
/// WHY A MODE MACHINE AND NOT A FLAG ON THE TURN
///
/// ADR-0051 §3.8 adds exactly ONE field to the wire — `read_aloud` — so there
/// is no `free_chat_mode` to read, and there is not meant to be.
///
/// The tempting shortcut is "the `free_chat_resume` chip is on this turn, so we
/// are in free mode". That is WRONG, and the server says so outright:
///
///   /// "Resume banayein" — attached to every free-mode line but the opener
///   /// and distress (R9).
///
/// Two free-mode turns therefore carry no résumé chip: the greeting, and a
/// DISTRESS turn (the Tele-MANAS line). Reading the mode off that chip would
/// flip the app back to interview behaviour on the one turn where being wrong
/// matters most — it would re-show the "build my profile" CTA under a suicide
/// helpline.
///
/// So the mode is STICKY and driven by what the worker TAPPED, mirroring the
/// server's own `chat.free_chat_mode_changed` (from / to / trigger):
///
///   * "Baad mein" (`free_chat_later`)   → free chat
///   * "Haan, shuru karein" (`free_chat_start`) → the interview
///   * "Resume banayein" (`free_chat_resume`)   → the interview
///
/// Anything else says NOTHING about the mode and must leave it alone — a
/// free-chat follow-up chip (`fcq_*`), an interview option, a typed message.
library;

/// "Haan, shuru karein" — start today's interview (résumé mode).
const String kFreeChatStartKey = 'free_chat_start';

/// "Baad mein" — open free chat.
const String kFreeChatLaterKey = 'free_chat_later';

/// "Resume banayein" — leave free chat for the interview. Offered on every
/// free-mode line EXCEPT the opener and distress, which is why it cannot be
/// used to detect the mode.
const String kFreeChatResumeKey = 'free_chat_resume';

/// The label the server serves for [kFreeChatResumeKey].
///
/// Posted as ordinary text, which is how every chip answers. The server reads
/// it either way: `isResumeChip` matches the key OR the normalised label.
const String kFreeChatResumeLabel = 'Resume banayein';

/// A model-written free-chat follow-up chip (`fcq_a`, `fcq_b`, …). Carried here
/// so [freeChatModeAfterTap] can be explicit that these do NOT move the mode.
const String kFreeChatFollowupKeyPrefix = 'fcq_';

/// Every key this build knows, for the parity pin.
const List<String> kFreeChatModeKeys = <String>[
  kFreeChatStartKey,
  kFreeChatLaterKey,
  kFreeChatResumeKey,
];

/// Whether [optionKey] is a free-chat chip of any kind — a mode chip or a
/// model-written follow-up.
///
/// Used to keep the greeting's own Haan / Baad mein taps out of the #1316
/// interview indices: choosing a mode is not answering an interview question.
bool isFreeChatKey(String? optionKey) {
  if (optionKey == null) return false;
  return kFreeChatModeKeys.contains(optionKey) ||
      optionKey.startsWith(kFreeChatFollowupKeyPrefix);
}

/// The mode after the worker taps [optionKey]: true = free chat, false = the
/// interview, null = this tap says nothing, so keep the mode you had.
///
/// Null is NOT "false". A free-chat follow-up chip, an interview option and a
/// typed message all land here, and treating any of them as "back to the
/// interview" would end free mode under the worker mid-conversation.
bool? freeChatModeAfterTap(String? optionKey) {
  switch (optionKey) {
    case kFreeChatLaterKey:
      return true;
    case kFreeChatStartKey:
    case kFreeChatResumeKey:
      return false;
    default:
      return null;
  }
}
