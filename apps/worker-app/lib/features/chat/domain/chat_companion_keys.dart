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

/// ADR-0046 **Phase 1** — the companion's TASK CHIPS, offered when the router
/// cannot act so a worker is never left without a next step.
///
/// SERVER-ANSWERED, NOT CLIENT-ROUTED. Unlike `companion_jobs_tab` and
/// `companion_applied`, none of these opens a screen: the app posts the chip's
/// LABEL as ordinary text (the chat's shipped convention) and the server's
/// classifier decides. They therefore fall through [companionActionFor] to
/// [CompanionAction.none] deliberately — that is the contract, not an omission.
///
/// The server keeps them in their own file (`companion-task-keys.ts`) so that
/// adding them could not redden this app's four-key v1 parity pin before an app
/// build that knows them existed; [kCompanionTaskKeys] is this side of that
/// mirror and `chat_companion_keys_test.dart` pins it to that file.
const String kCompanionTaskEditResumeKey = 'companion_task:edit_resume';
const String kCompanionTaskNewResumeKey = 'companion_task:new_resume';
const String kCompanionTaskCareerTalkKey = 'companion_task:career_talk';

/// What every task key starts with. A NEW namespace, disjoint from v1's
/// `companion_` + suffix keys, so a shipped client can tell a v2-only chip from
/// one it has always known — which is what [isCompanionV2OnlyKey] needs.
const String kCompanionTaskKeyPrefix = 'companion_task:';

/// Every task key this build knows, for the parity test and the analytics map.
const List<String> kCompanionTaskKeys = <String>[
  kCompanionTaskEditResumeKey,
  kCompanionTaskNewResumeKey,
  kCompanionTaskCareerTalkKey,
];

/// Whether [optionKey] is a chip only a v2-enabled build may show.
///
/// THE LEVER GATES THE DOOR AS WELL AS THE ROOM (ADR-0046 F4: the Remote Config
/// key gates F1–F3). "Resume badlo" is the one task chip Phase 1 actually
/// serves, and tapping it asks the server for an edit proposal — whose card the
/// same lever hides. Offered on a lever-off build it is a door onto a room that
/// is bricked up: the worker taps, the message posts, the server proposes an
/// edit, and the reply arrives with no card and no Haan to press. So a lever-off
/// build does not draw it.
///
/// KEYED ON THE PREFIX, not on the three known keys, so a fourth task chip the
/// server adds tomorrow is hidden by an old build rather than shown bare.
bool isCompanionV2OnlyKey(String optionKey) =>
    optionKey.startsWith(kCompanionTaskKeyPrefix);

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

/// #1752 — the confirmation after applying through a companion job chip. The
/// SAME word the jobs feed uses for the same pop, so one action reads one way.
const String kCompanionAppliedToast = 'Applied';

/// #1753 — a chip's key CLASS, for counts-only analytics. Never the key itself
/// (a job key carries a posting id) and never the label.
String companionChipKeyClass(String optionKey) {
  if (optionKey.startsWith(kCompanionJobKeyPrefix)) return 'job';
  switch (optionKey) {
    case kCompanionJobsTabKey:
      return 'jobs_tab';
    case kCompanionAppliedKey:
      return 'applied';
    case kCompanionNewJobsKey:
      return 'new_jobs';
    case kCompanionResumeKey:
      return 'resume';
    case kCompanionTaskEditResumeKey:
      return 'task_edit_resume';
    case kCompanionTaskNewResumeKey:
      return 'task_new_resume';
    case kCompanionTaskCareerTalkKey:
      return 'task_career_talk';
    default:
      return 'other';
  }
}
