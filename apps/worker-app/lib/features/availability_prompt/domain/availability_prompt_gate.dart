import 'package:equatable/equatable.dart';

import '../../../core/api/api_client.dart'
    show
        WorkAvailabilityDto,
        WorkPrefOptionsDto,
        WorkPreferencesDto,
        kAvailabilityStatusLabels;
import '../../../core/config/remote_config.dart';
import '../../profile_edit/domain/profile_edit_models.dart'
    show AvailabilityDraft;
import '../../profile_edit/domain/profile_edit_repository.dart';

/// The `availability` wire key, as `GET`/`PUT /workers/me/work-preferences`
/// name it (and as `partial` reports a withheld value).
const String kAvailabilityWireKey = 'availability';

/// Whether [prefs] leaves the worker's availability EMPTY — the only case the
/// shell asks (#2748 item 1d).
///
/// Empty means no stored status. A value the server WITHHELD (`partial`) is
/// not empty: it is stored, it just failed today's schema on the read, and the
/// `PUT` replaces the whole object, so asking would overwrite an answer the
/// worker already gave.
bool availabilityPromptDue(WorkPreferencesDto prefs) {
  if (prefs.partial.contains(kAvailabilityWireKey)) return false;
  final String status = prefs.availability?.status?.trim() ?? '';
  return status.isEmpty;
}

/// The choices the prompt offers, `slug → label`, in chip order.
///
/// The SERVED `availability_status` dictionary whenever the server sends one —
/// the set the `PUT`'s strict `z.enum` validates, so a chip drawn from it can
/// never 400. [kAvailabilityStatusLabels] covers only a server that predates
/// that key; its slugs are today's server values, never planned ones.
Map<String, String> availabilityPromptOptions(WorkPrefOptionsDto options) =>
    options.availabilityStatus.isEmpty
    ? kAvailabilityStatusLabels
    : options.availabilityStatus;

/// The `PUT /workers/me/work-preferences` body for one answer: ONLY the
/// `availability` key, so every other stored preference is left alone.
///
/// The server replaces the whole availability object, so the body carries
/// the [stored] date and notice days alongside the new [status] — the same
/// rule the profile editor follows — rather than nulling them.
/// `touched_only: true` is the new-build signal (#1504).
Map<String, dynamic> availabilityPromptBody(
  String status, {
  WorkAvailabilityDto? stored,
}) => <String, dynamic>{
  'touched_only': true,
  kAvailabilityWireKey: AvailabilityDraft(
    status: status,
    availableFrom: stored?.availableFrom,
    noticePeriodDays: stored?.noticeDays,
  ).toJson(),
};

/// What the shell needs to ask: the choices, and the stored availability
/// object the answer must not erase.
class AvailabilityPrompt extends Equatable {
  const AvailabilityPrompt({required this.options, this.stored});

  /// `slug → label`, in chip order — see [availabilityPromptOptions].
  final Map<String, String> options;

  /// The stored availability (its status empty), or null when no row exists.
  final WorkAvailabilityDto? stored;

  @override
  List<Object?> get props => <Object?>[options, stored];
}

/// Decides whether the home shell asks for availability now (#2748 item 1d).
///
/// Both onboarding paths already ask it (the trade form's preferences page and
/// the chat's tail); this catches a worker who skipped it. WHERE it is asked is
/// the caller's job (the home shell, past onboarding); this owns WHETHER.
///
/// App-scoped singleton: [claim] answers with a prompt at most once per worker
/// per app launch, so a dismissed prompt is not asked again in the same
/// session, and a saved answer leaves nothing empty to ask about. Advisory
/// only — the server validates every value written.
class AvailabilityPromptGate {
  AvailabilityPromptGate({
    required ProfileEditRepository repository,
    required bool Function() isSignedIn,
    required String? Function() workerId,
    bool Function()? isEnabled,
  }) : _repository = repository,
       _isSignedIn = isSignedIn,
       _workerId = workerId,
       _isEnabled = isEnabled ?? _remoteSwitch;

  final ProfileEditRepository _repository;
  final bool Function() _isSignedIn;
  final String? Function() _workerId;
  final bool Function() _isEnabled;

  final Set<String> _claimedThisLaunch = <String>{};

  static bool _remoteSwitch() =>
      BbRemoteConfig.instance.availabilityPromptEnabled;

  /// The prompt to show now, or null. Uses up this launch's one check for the
  /// signed-in worker whatever the answer — but only once the Remote Config
  /// switch is on, so a value that activates after the first frame still gets
  /// its one check. NEVER throws: any failure (offline, a failed read, no
  /// session) means no prompt.
  Future<AvailabilityPrompt?> claim() async {
    try {
      if (!_isEnabled()) return null;
      if (!_isSignedIn()) return null;
      if (!_claimedThisLaunch.add(_workerId() ?? '')) return null;
      // The stored answer first: a worker who has one never costs the
      // options read.
      final WorkPreferencesDto prefs = await _repository.loadWorkPreferences();
      if (!availabilityPromptDue(prefs)) return null;
      final WorkPrefOptionsDto options = await _repository
          .loadWorkPreferenceOptions();
      return AvailabilityPrompt(
        options: availabilityPromptOptions(options),
        stored: prefs.availability,
      );
    } catch (_) {
      return null;
    }
  }
}
