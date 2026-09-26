/// The post-completion companion's chip keys (ADR-0044; backend
/// `apps/api/src/chat-companion/companion-keys.ts`).
///
/// The SERVER owns the copy and the client routes on these keys, NEVER on the
/// labels — the same contract as the résumé menu (`chat_resume_menu.dart`). The
/// fixed keys and the job-key prefix are byte-checked against the server source
/// by `chat_companion_keys_test.dart`.
///
/// Three are handled HERE and never posted (a job's detail, the Jobs tab, the
/// applied list). `companion_new_jobs` and `companion_resume` fall through to
/// [CompanionAction.none]: the app posts their LABEL as ordinary text and the
/// server answers — `companion_resume` with the existing résumé menu, whose own
/// keys `resumeMenuActionFor` then routes exactly as it always has.
library;

/// Server-answered: the new jobs reply (up to three job chips).
const String kCompanionNewJobsKey = 'companion_new_jobs';

/// App-routed: switch to the Jobs tab.
const String kCompanionJobsTabKey = 'companion_jobs_tab';

/// App-routed: open the applied-jobs list.
const String kCompanionAppliedKey = 'companion_applied';

/// Server-answered: the existing résumé menu (edit / redo), verbatim.
const String kCompanionResumeKey = 'companion_resume';

/// App-routed: ONE job's detail. The key is this prefix plus the posting id.
const String kCompanionJobKeyPrefix = 'companion_job:';

/// What separates a job chip's title from its city (`"CNC Operator — Pune"`).
/// The server strips it from titles, so splitting on it is safe.
const String kCompanionJobLabelSeparator = ' — ';

/// What tapping a companion option should DO.
enum CompanionAction {
  /// Not a client-routed companion key: fall through to the résumé-menu routing
  /// and then to an ordinary send — exactly today's behaviour for every chip.
  none,

  /// `companion_job:<id>` → that job's detail screen.
  openJob,

  /// `companion_jobs_tab` → the Jobs tab.
  openJobsTab,

  /// `companion_applied` → the applied-jobs list.
  openApplied,
}

/// Classify a served `option_key`. Anything that is not a client-routed
/// companion key is [CompanionAction.none], so this can never change how an
/// interview chip or a résumé-menu chip behaves.
CompanionAction companionActionFor(String optionKey) {
  switch (optionKey) {
    case kCompanionJobsTabKey:
      return CompanionAction.openJobsTab;
    case kCompanionAppliedKey:
      return CompanionAction.openApplied;
    default:
      // CLASSIFY ON THE PREFIX, NOT THE PAYLOAD (#1747 review). Keying this on
      // `companionJobId() != null` meant a `companion_job:` chip whose payload
      // is not a uuid answered `none` — so it fell through the résumé-menu
      // routing into the ordinary send, and the worker's own transcript gained
      // the chip's LABEL as a message he never typed. It is a companion job
      // chip either way; the `jobId == null` guard at the call site is what
      // makes a malformed one do nothing at all.
      return optionKey.startsWith(kCompanionJobKeyPrefix)
          ? CompanionAction.openJob
          : CompanionAction.none;
  }
}

final RegExp _uuid = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

/// The posting id inside a `companion_job:<id>` key, or null when [optionKey]
/// is not one (or carries anything but a uuid — never build a route from it).
String? companionJobId(String optionKey) {
  if (!optionKey.startsWith(kCompanionJobKeyPrefix)) return null;
  final String id = optionKey.substring(kCompanionJobKeyPrefix.length);
  return _uuid.hasMatch(id) ? id : null;
}

/// A job chip's label split back into the detail header's title and city.
({String title, String? city}) companionJobLabelParts(String label) {
  final int at = label.lastIndexOf(kCompanionJobLabelSeparator);
  if (at <= 0) return (title: label.trim(), city: null);
  final String city = label.substring(at + kCompanionJobLabelSeparator.length).trim();
  return (title: label.substring(0, at).trim(), city: city.isEmpty ? null : city);
}
