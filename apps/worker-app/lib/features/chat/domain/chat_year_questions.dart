/// THE CHAT'S CALENDAR-YEAR QUESTIONS (`date_issue.jpeg`).
///
/// A pack question whose answer is a CALENDAR YEAR is served as
/// `answer_type: "number"`, which on the client only swapped the keyboard to a
/// number pad — so "2050" was typed, accepted and written to `training_year`.
/// Neither the pack entry nor the server bounds the value, and ruling out an
/// impossible year is a deterministic business rule, not something an LLM may
/// be trusted to catch (CLAUDE.md §3).
///
/// THESE ARE SERVER KEYS, MIRRORED — exactly as `chat_identity_questions.dart`
/// mirrors the identity intake's. The app invents no behaviour the server did
/// not ask for: a question it does not recognise keeps today's text composer.
/// The key arrives as `asked_question_id` (`chat.service.ts`:
/// `asked_question_id: turn.questionKey`), so this needs no contract change.
library;

/// `training_year` — "Training kis saal ki thi?"
/// (`packages/db/data/question-packs/packs/qp_universal@4.json`).
const String kChatTrainingYearQuestionKey = 'training_year';

/// The earliest year offered. The SAME living-memory floor the trade form's
/// qualifications and employment pages use (and the `wc_year_chk` /
/// `wed_year_chk` database checks allow), so the app states one rule.
const int kChatYearMin = 1950;

/// Whether [questionKey] asks for a calendar year, and so is answered with the
/// year picker instead of a free-text box.
///
/// DELIBERATELY NOT `experience_years`: that question ("Is kaam mein aapko kitne
/// saal ho gaye?") is a DURATION, where 5 is the right answer and 2026 is not.
/// Putting a year picker on it would be the opposite bug.
bool isChatYearQuestion(String? questionKey) =>
    questionKey == kChatTrainingYearQuestionKey;

/// Every year a worker may choose for [questionKey], newest first.
///
/// [now] is injected so a test does not depend on the wall clock. A FUTURE year
/// is not in the list at all, which is the whole point: an impossible answer is
/// unreachable rather than merely rejected afterwards.
List<int> chatYearOptions({required DateTime now}) =>
    <int>[for (int y = now.year; y >= kChatYearMin; y--) y];
