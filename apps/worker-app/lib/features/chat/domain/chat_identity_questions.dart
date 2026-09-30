/// ADR-0048 — THE CHAT'S IDENTITY INTAKE.
///
/// The chat asks a worker for whatever their record is missing — first name,
/// surname, state, city — as its opening turns, and writes the answers straight
/// to the worker record (`workers.full_name`, `current_state`, `current_city`).
/// It replaced the `/name` form screen (#1864).
///
/// THESE ARE SERVER KEYS, MIRRORED. The app routes on them for two things and
/// neither invents behaviour the server did not ask for:
///
///   * the two LOCATION questions get the pickers the `/name` screen had, so a
///     worker is not asked to spell their state into a text box; and
///   * an intake open must not be mistaken for a résumé import that yielded
///     nothing (#1660) — see `_maybeSayEmptyImport`.
///
/// ANSWERS ARE ORDINARY CHAT TEXT. A picker submits the chosen label exactly as
/// typing it would; the server canonicalises and never refuses a place name.
library;

/// `worker_first_name` — asked first when the record has no name.
const String kChatFirstNameQuestionKey = 'worker_first_name';

/// `worker_last_name` — skipped when the first answer already carried 2+ words.
const String kChatLastNameQuestionKey = 'worker_last_name';

/// `worker_state` — the State picker.
const String kChatStateQuestionKey = 'worker_state';

/// `worker_city` — the City picker, filtered by the state just answered.
const String kChatCityQuestionKey = 'worker_city';

/// Every intake key, for the "is this an intake turn?" tests.
const Set<String> kChatIdentityQuestionKeys = <String>{
  kChatFirstNameQuestionKey,
  kChatLastNameQuestionKey,
  kChatStateQuestionKey,
  kChatCityQuestionKey,
};

/// Whether [questionKey] is one of the two the app answers with a PICKER.
bool isChatLocationQuestion(String? questionKey) =>
    questionKey == kChatStateQuestionKey || questionKey == kChatCityQuestionKey;
