import 'package:shared_preferences/shared_preferences.dart';

/// A fact about a worker that more than one surface could ask for.
///
/// Lives in core, not in a feature, because three features share it: /name and
/// the chat RECORD a fact once the worker has given it, and the trade form and
/// the finishing form READ it so they do not ask again ("ask once, skip if
/// known").
enum WorkerFact {
  trade,
  currentCity,
  preferredCities,
  salary,
  shift,
  education,
  tradeTenure,
  relocation,
  languages,
  documents,
  jobType,
  accommodation,
  workHistory,
  certificates,
}

/// Which [WorkerFact]s this signed-in worker has ALREADY given on an earlier
/// screen, so a later screen can skip asking them again.
///
/// Why the client has to remember it: none of the surfaces that re-ask a fact
/// (the trade form's questions, its preferences sub-pages, the finishing form)
/// has a server read of "already known". A fact is recorded only after the
/// server ACCEPTED the write that carried it (see each recorder), and a missing
/// record only means the question is asked again, which is the old behaviour.
///
/// PII-FREE BY CONSTRUCTION: it stores fact NAMES, never a value the worker
/// entered. It is still cleared on logout (`_clearSessionScopedCaches`) so the
/// next worker on a shared phone is asked everything.
abstract interface class KnownWorkerFactsStore {
  /// Every fact recorded for the signed-in worker. Best-effort, NEVER throws.
  Future<Set<WorkerFact>> knownFacts();

  /// Records that the worker has given [fact]. Best-effort, NEVER throws.
  Future<void> record(WorkerFact fact);

  /// Forgets every recorded fact. Best-effort, NEVER throws.
  Future<void> clearAll();
}

/// [KnownWorkerFactsStore] over `shared_preferences`, so a cold start between
/// /name, the chat and a form does not re-ask what was already given.
///
/// Resolves [SharedPreferences] LAZILY on each call, so REGISTERING it never
/// touches the platform channel. Every method swallows a plugin error: a storage
/// failure only means a fact is asked again.
class SharedPrefsKnownWorkerFactsStore implements KnownWorkerFactsStore {
  const SharedPrefsKnownWorkerFactsStore({
    Future<SharedPreferences> Function() prefs = SharedPreferences.getInstance,
  }) : _prefs = prefs;

  final Future<SharedPreferences> Function() _prefs;

  /// `bb_`-prefixed to match the existing key convention.
  static const String kKey = 'bb_known_worker_facts';

  @override
  Future<Set<WorkerFact>> knownFacts() async {
    try {
      final SharedPreferences prefs = await _prefs();
      final List<String> names = prefs.getStringList(kKey) ?? const <String>[];
      // An unknown name (a fact a later build added) is ignored, never fatal.
      return <WorkerFact>{
        for (final WorkerFact fact in WorkerFact.values)
          if (names.contains(fact.name)) fact,
      };
    } catch (_) {
      return <WorkerFact>{};
    }
  }

  @override
  Future<void> record(WorkerFact fact) async {
    try {
      final SharedPreferences prefs = await _prefs();
      final Set<String> names = <String>{
        ...?prefs.getStringList(kKey),
        fact.name,
      };
      await prefs.setStringList(kKey, names.toList());
    } catch (_) {
      // Best-effort: an unrecorded fact is simply asked again.
    }
  }

  @override
  Future<void> clearAll() async {
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.remove(kKey);
    } catch (_) {
      // Best-effort: a teardown failure must never block sign-out.
    }
  }
}

/// In-memory [KnownWorkerFactsStore]: the seam unit tests inject, and the
/// default wherever persistence is not wired (every fact is then asked, as
/// before).
class InMemoryKnownWorkerFactsStore implements KnownWorkerFactsStore {
  InMemoryKnownWorkerFactsStore([Iterable<WorkerFact> facts = const <WorkerFact>[]])
      : _facts = <WorkerFact>{...facts};

  final Set<WorkerFact> _facts;

  @override
  Future<Set<WorkerFact>> knownFacts() async => <WorkerFact>{..._facts};

  @override
  Future<void> record(WorkerFact fact) async => _facts.add(fact);

  @override
  Future<void> clearAll() async => _facts.clear();
}
