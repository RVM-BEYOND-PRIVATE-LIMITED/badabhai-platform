import '../../../core/session/known_worker_facts_store.dart' show WorkerFact;

/// The chat's closing questions (`qp_universal@2`) whose facts a later form
/// asks again, keyed by the `asked_question_id` the engine serves them under.
const String kChatCurrentCityQuestionId = 'current_city';
const String kChatPreferredLocationsQuestionId = 'preferred_locations';
const String kChatSalaryExpectedQuestionId = 'salary_expected';
const String kChatShiftPreferenceQuestionId = 'shift_preference';

/// Matches any digit — the only shape of a salary this client trusts without a
/// chip (see [chatAnsweredFact]).
final RegExp _kDigit = RegExp(r'\d');

/// The [WorkerFact] a delivered chat answer settled, or null when it settled
/// none the client can be sure of.
///
/// Called only for a reply the server PROCESSED (delivered, not blocked).
/// [askedQuestionId] is the question the worker was answering, [reply] what
/// they sent, [tappedOption] whether it came from a served chip that is not a
/// decline, and [unansweredEssentials] the NEXT turn's still-missing mandatory
/// keys.
///
/// CONSERVATIVE ON PURPOSE. A wrong "known" hides a question for good; a missed
/// one only asks it again. So each fact is recorded only on evidence the server
/// kept it:
///  * current city — a mandatory item: known once it leaves
///    `unanswered_essentials`, the server's own "settled" signal;
///  * preferred cities — stored verbatim: any non-empty answer;
///  * salary — parsed server-side and dropped when the parser misses: a chip,
///    or a typed answer carrying a number;
///  * shift — a closed list that drops unmatched text: a chip only.
WorkerFact? chatAnsweredFact({
  required String? askedQuestionId,
  required String reply,
  required bool tappedOption,
  required List<String> unansweredEssentials,
}) {
  if (reply.trim().isEmpty) return null;
  switch (askedQuestionId) {
    case kChatCurrentCityQuestionId:
      return unansweredEssentials.contains(kChatCurrentCityQuestionId)
          ? null
          : WorkerFact.currentCity;
    case kChatPreferredLocationsQuestionId:
      return WorkerFact.preferredCities;
    case kChatSalaryExpectedQuestionId:
      return tappedOption || _kDigit.hasMatch(reply) ? WorkerFact.salary : null;
    case kChatShiftPreferenceQuestionId:
      return tappedOption ? WorkerFact.shift : null;
    default:
      return null;
  }
}
