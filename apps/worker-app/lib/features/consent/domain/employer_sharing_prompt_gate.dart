import '../../../core/api/api_client.dart' show kConsentVersion;
import 'consent_repository.dart';
import 'employer_contact.dart';
import 'employer_sharing_prompt_store.dart';

/// The server half of the one-time prompt's show condition: the worker has a
/// LIVE consent row that lacks an employer purpose and certifies an OLDER
/// notice than [noticeVersion].
///
/// The version clause is what keeps a worker who already SAW this notice from
/// being asked again — one who onboarded on this build, or granted and later
/// switched it off in Settings (the withdraw keeps the row's version).
bool employerSharingPromptDue(
  EmployerContactInfo info, {
  required String noticeVersion,
}) =>
    info.hasLiveRow && !info.enabled && info.consentVersion != noticeVersion;

/// Decides whether the one-time employer-sharing prompt opens now, and records
/// "Abhi nahi" so it does not open again on this device.
///
/// WHERE it is asked is the caller's job (the home shell, past onboarding);
/// this owns WHETHER. App-scoped singleton: [claim] answers yes at most once
/// per worker per app launch. Advisory only — the server decides what a grant
/// may write.
class EmployerSharingPromptGate {
  EmployerSharingPromptGate({
    required ConsentRepository repository,
    required EmployerSharingPromptStore store,
    required bool Function() isSignedIn,
    required String? Function() workerId,
    this.noticeVersion = kConsentVersion,
  })  : _repository = repository,
        _store = store,
        _isSignedIn = isSignedIn,
        _workerId = workerId;

  final ConsentRepository _repository;
  final EmployerSharingPromptStore _store;
  final bool Function() _isSignedIn;
  final String? Function() _workerId;

  /// The notice version the prompt shows (and a grant certifies).
  final String noticeVersion;

  final Set<String> _claimedThisLaunch = <String>{};

  /// True when the prompt should open now. Uses up this launch's one check for
  /// the signed-in worker whatever the answer. NEVER throws: any failure
  /// (offline, `GET /consent/me` error, no session) means no prompt.
  Future<bool> claim() async {
    try {
      if (!_isSignedIn()) return false;
      if (!_claimedThisLaunch.add(_workerId() ?? '')) return false;
      // Server first: a worker the server says is not due never touches disk.
      final EmployerContactInfo info = await _repository.employerContactState();
      if (!employerSharingPromptDue(info, noticeVersion: noticeVersion)) {
        return false;
      }
      return !await _store.isDismissed(
        version: noticeVersion,
        workerId: _workerId(),
      );
    } catch (_) {
      return false;
    }
  }

  /// Remembers "Abhi nahi" for this worker + notice version. NEVER throws.
  Future<void> recordDismissal() async {
    try {
      await _store.markDismissed(
        version: noticeVersion,
        workerId: _workerId(),
      );
    } catch (_) {
      // Best-effort: a lost mark only costs one more prompt next launch.
    }
  }
}
