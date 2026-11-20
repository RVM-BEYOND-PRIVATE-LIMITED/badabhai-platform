/// Claims the monthly card at most ONCE per app launch, per worker.
///
/// The card is a server fact (`due`) but a UI prompt, and the shell can remount
/// during one launch (a root route such as `/invite` disposes it). Without this
/// memory, ignoring the card once would pop it again on every return to the
/// tabs. App-scoped, like the employer-sharing and availability prompt gates;
/// a fresh launch is a fresh instance, so an ignored check is offered again on
/// the next app open.
class StillLookingPromptGate {
  final Set<String> _claimed = <String>{};

  /// True the first time this worker is seen in this launch. A missing id
  /// falls back to one device-wide slot rather than forgetting entirely.
  bool claim({String? workerId}) {
    final String who = (workerId == null || workerId.isEmpty)
        ? 'device'
        : workerId;
    return _claimed.add(who);
  }
}
