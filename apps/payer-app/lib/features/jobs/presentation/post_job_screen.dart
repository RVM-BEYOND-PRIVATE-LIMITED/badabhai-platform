import 'dart:async';

import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/data/payer_api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_toast.dart';
import 'widgets/job_content_input.dart';
import 'widgets/match_skill_picker.dart';

/// Availability of the Matching-V1 demand-skill picker, resolved once at load.
///
///  - [loading]     — `fetchMatchSkills()` in flight; Post is held until known.
///  - [available]   — the route answered with skills; show the picker + reach
///    meter and gate Post on at least one skill picked (a zero reach preview is
///    informational — reach is dynamic, so it does not block posting).
///  - [unavailable] — the route is off server-side (`MATCH_V1_ENABLED` false →
///    404/error) or returned nothing; HIDE the picker and fall back to the
///    existing free-text skills flow so posting still works.
enum _MatchV1 { loading, available, unavailable }

/// Post a job — role-branched on [AppSession.role].
///
///  - COMPANY: `POST /payer/job-postings` (201 draft; publish it later from
///    My-jobs) accepts `org_label`, `role_title`, optional `location_label`,
///    free-text `description`, EXACTLY ONE of `vacancy_band | vacancies`, and —
///    since #1646/#1648 — the worker-visible content columns: `city`, `area`,
///    `pay_min`/`pay_max`/`pay_type`, `min_experience_years`/
///    `max_experience_years`, `shift`, `needed_by`, `benefits`, `requirements`.
///    It still has NO trade column, so only the trade (and the V1-off free-text
///    skills) is folded into `description` — see
///    [_PostJobScreenState._companyDescription]. Nothing is prefilled: every
///    free-text input starts empty (#357).
///  - AGENCY: sends the faceless demand attributes the agent route accepts —
///    `trade_key`, `title`, `city`, optional `area`, `pay_min`/`pay_max`,
///    `pay_type`, `min_experience_years`/`max_experience_years`, `needed_by`,
///    plus the worker-visible `description`/`shift`/`benefits`/`requirements` —
///    to `POST /payer/agency/jobs` (201 → live `open`; refetch My-jobs). Unlike
///    the company route, agency DOES take the trade as a typed column.
///    NEVER an employer name or worker identity (no such field on this contract).
class PostJobScreen extends StatefulWidget {
  const PostJobScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  State<PostJobScreen> createState() => _PostJobScreenState();
}

class _PostJobScreenState extends State<PostJobScreen> {
  late final TextEditingController _org;

  // #357 — every free-text input starts EMPTY. These used to ship fabricated
  // demo values ('CNC Setter' / 'Pimpri, Pune' / 'Pune' / 'Chakan') that the
  // submit path sent VERBATIM to the real create routes, so a payer who tapped
  // straight through published a posting they never typed.
  final TextEditingController _title = TextEditingController();
  final TextEditingController _location = TextEditingController();

  // --- Coarse pay / experience bands — used by BOTH branches ----------------
  // The session role is locked at login, so only one branch is ever mounted and
  // these four controllers are shared. BOTH routes now take them as typed
  // columns (#1646 added the company ones) — #357 had folded the company's into
  // `description` because the create schema had nowhere else to put them.
  final TextEditingController _payMin = TextEditingController();
  final TextEditingController _payMax = TextEditingController();
  final TextEditingController _expMin = TextEditingController();
  final TextEditingController _expMax = TextEditingController();

  // --- Agency-only input (`POST /payer/agency/jobs`) -------------------------
  final TextEditingController _city = TextEditingController();

  // COARSE locality bucket ("Chakan"), shared by both branches (#1646 gave the
  // company create an `area` column too). NEVER an address, and never derived
  // from the company form's free-text Location — the server keeps that wall on
  // purpose, so the payer types this one himself.
  final TextEditingController _area = TextEditingController();

  // --- Worker-visible content (BOTH branches now) ---------------------------
  // `description` / `shift` / `benefits` / `requirements` — the fields the
  // WORKER's job card renders verbatim. The agency create always accepted them;
  // #1646 gave the company create `benefits`/`requirements` as real columns too
  // (its description is still composed — see [_companyDescription]). Shift
  // reuses the shared [_shift]; one branch is ever mounted, like the pay bands.
  // #357: nothing is prefilled, an untouched input sends nothing, and a chip is
  // only ever a phrase the payer typed.
  final TextEditingController _description = TextEditingController();
  final List<String> _benefits = <String>[];
  final List<String> _requirements = <String>[];

  static const List<String> _trades = <String>[
    'CNC Setter',
    'VMC Setter',
    'CNC Operator',
    'Quality Inspector',
    'Welder / Fabricator',
    'Fitter',
  ];

  /// The server's `vacancy_band` enum — exact values the route accepts.
  static const List<String> _bands = <String>['1', '2-5', '6-10', '11-25', '25+'];

  /// Server bound on skill phrases (`skillsInput`: <=10 phrases, 1..80 chars).
  /// Mirrored here so the chip row cannot outgrow what the contract allows.
  static const int _maxSkills = 10;
  static const int _maxSkillChars = 80;


  /// Company trade — null until the payer picks one (#357: a default of
  /// 'CNC Setter' would put a trade the payer never chose into `description`).
  String? _trade;
  String _band = '2-5';
  // Agency `trade_key` enum + coarse `needed_by` timing (server-accepted values).
  String _tradeKey = kAgencyTradeKeys.first;
  String _neededBy = kAgencyNeededBy.first;
  // #357 — starts empty; '+ Add skill' prompts for a real phrase instead of
  // inserting the literal placeholder 'Skill N'. Used ONLY on the V1-off
  // fallback path (when the demand-skill picker is unavailable).
  final List<String> _skills = <String>[];
  bool _submitting = false;

  // --- Matching V1 (COMPANY posting only) -----------------------------------
  // The demand-skill picker + live reach meter. All additive: if the route is
  // off server-side we degrade to the free-text skills flow (see [_MatchV1]).

  /// Fallback cap until a reach preview reports the server's real
  /// `max_skills_per_posting`. Kept small so we never overshoot the contract.
  static const int _matchSkillCapFallback = 5;

  _MatchV1 _matchV1 = _MatchV1.loading;
  List<MatchSkill> _matchSkills = const <MatchSkill>[];
  final Set<String> _pickedSkillIds = <String>{};
  final Set<String> _untickedRelatedIds = <String>{};
  ReachPreview? _reach;
  bool _reachLoading = false;
  // True when the LAST reach preview fetch FAILED (network/5xx). Distinct from
  // "no preview yet": without it a failed fetch left `_reach == null` and the
  // meter span "Counting workers…" forever with Post stuck disabled and no
  // retry. Reset when a fetch starts / succeeds / the pick is cleared.
  bool _reachFailed = false;
  int _maxSkillsPerPosting = _matchSkillCapFallback;
  int _reachSeq = 0;
  Timer? _reachDebounce;

  /// Coarse structured demand attributes. Null = "not set", so we never
  /// fabricate a shift/timing the payer did not choose (#357).
  String? _shift;
  String? _companyNeededBy;

  /// What the ₹ band MEANS — `in_hand|gross|ctc` (#1648), shared by both
  /// branches. Null is the ONLY honest default: the platform never guesses
  /// net-vs-gross, so an unpicked pay type sends nothing and the worker's card
  /// shows the band with no pay-type pill.
  String? _payType;

  bool get _isAgency =>
      locator<AppSessionCubit>().state?.isAgency ?? false;

  @override
  void initState() {
    super.initState();
    // org_label is required by the company route; default it to the signed-in
    // account name (editable) so the posting is attributed to the right org.
    final String orgName =
        locator<AppSessionCubit>().state?.account.name ?? '';
    _org = TextEditingController(text: orgName);
    // The picker is a COMPANY-only surface. Load it lazily and fail soft: any
    // error (route disabled, network) drops us to the free-text fallback.
    if (!_isAgency) {
      // ignore: discarded_futures — fire-and-forget load; state updates on done.
      _loadMatchSkills();
    } else {
      _matchV1 = _MatchV1.unavailable;
    }
  }

  @override
  void dispose() {
    _reachDebounce?.cancel();
    _org.dispose();
    _title.dispose();
    _location.dispose();
    _city.dispose();
    _area.dispose();
    _description.dispose();
    _payMin.dispose();
    _payMax.dispose();
    _expMin.dispose();
    _expMax.dispose();
    super.dispose();
  }

  /// Load the closed demand-skill set. GRACEFUL DEGRADATION: the match routes
  /// may be disabled (`MATCH_V1_ENABLED` off → 404/error). On any failure — or
  /// an empty set — we mark V1 [unavailable], which HIDES the picker + reach UI
  /// and keeps the existing free-text skills flow so posting still works. Never
  /// throws to the tree.
  Future<void> _loadMatchSkills() async {
    try {
      final List<MatchSkill> skills =
          await locator<PayerApiClient>().fetchMatchSkills();
      if (!mounted) return;
      setState(() {
        _matchSkills = skills;
        _matchV1 =
            skills.isEmpty ? _MatchV1.unavailable : _MatchV1.available;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _matchV1 = _MatchV1.unavailable);
    }
  }

  /// Toggle a demand skill. Adding is capped at [_maxSkillsPerPosting]; emptying
  /// the set clears the reach meter, otherwise a debounced preview is scheduled.
  void _onToggleSkill(String id) {
    setState(() {
      if (_pickedSkillIds.contains(id)) {
        _pickedSkillIds.remove(id);
      } else if (_pickedSkillIds.length < _maxSkillsPerPosting) {
        _pickedSkillIds.add(id);
      }
    });
    if (_pickedSkillIds.isEmpty) {
      _reachDebounce?.cancel();
      setState(() {
        _reach = null;
        _reachLoading = false;
      });
    } else {
      _scheduleReach();
    }
  }

  /// Untick / re-tick a related skill (excludes/includes its reach slice).
  void _onToggleRelated(String id) {
    setState(() {
      if (!_untickedRelatedIds.remove(id)) _untickedRelatedIds.add(id);
    });
    _scheduleReach();
  }

  /// Debounce reach previews so a burst of taps makes ONE call (~350ms idle).
  void _scheduleReach() {
    _reachDebounce?.cancel();
    _reachDebounce =
        Timer(const Duration(milliseconds: 350), _loadReach);
  }

  /// Fetch the deterministic reach preview for the current pick. A [_reachSeq]
  /// token drops stale responses; a failure keeps the last known reach (marked
  /// not-loading) rather than flipping the meter to a fabricated zero.
  Future<void> _loadReach() async {
    final List<String> ids = _pickedSkillIds.toList(growable: false);
    if (ids.isEmpty) {
      if (mounted) {
        setState(() {
          _reach = null;
          _reachLoading = false;
          _reachFailed = false;
        });
      }
      return;
    }
    final int seq = ++_reachSeq;
    setState(() {
      _reachLoading = true;
      _reachFailed = false;
    });
    try {
      final ReachPreview preview =
          await locator<PayerApiClient>().reachPreview(
        matchSkillIds: ids,
        untickedRelatedIds: _untickedRelatedIds.toList(growable: false),
      );
      if (!mounted || seq != _reachSeq) return;
      setState(() {
        _reach = preview;
        _reachLoading = false;
        if (preview.maxSkillsPerPosting > 0) {
          _maxSkillsPerPosting = preview.maxSkillsPerPosting;
        }
      });
    } catch (_) {
      if (!mounted || seq != _reachSeq) return;
      // Surface the failure (and offer a retry) instead of leaving the meter on
      // a forever "Counting workers…" spinner with Post stuck disabled.
      setState(() {
        _reachLoading = false;
        _reachFailed = true;
      });
    }
  }

  /// Post is disabled for the company path while V1 is [loading], and requires at
  /// least one demand skill picked (so the job is matchable). It does NOT require
  /// a non-zero reach preview: reach is dynamic — the backend links workers who
  /// join later to an existing open posting — so a zero-reach-today job is still
  /// worth posting. The agency path and the V1-off fallback are ungated.
  bool get _companyCanPost {
    switch (_matchV1) {
      case _MatchV1.loading:
        return false;
      case _MatchV1.unavailable:
        return true;
      case _MatchV1.available:
        // DYNAMIC REACH: a company job's reach is NOT frozen at post time. The
        // backend's `reconcileReachForWorker` links a worker who joins/updates
        // LATER to an already-open matching posting, so a job that reaches no one
        // today can reach someone next week (and the server create never rejected
        // a zero-reach post). So Post only needs at least one skill — enough for
        // the job to be matchable now or in future; a zero reach PREVIEW is
        // informational, not a blocker (was the old E13 hard gate).
        return _pickedSkillIds.isNotEmpty;
    }
  }

  /// A trimmed whole-number field → int, or null when empty/invalid (an optional
  /// coarse band).
  static int? _intOrNull(String raw) {
    final String t = raw.trim();
    if (t.isEmpty) return null;
    return int.tryParse(t);
  }

  /// Shared min/max ordering check for the coarse bands — returns an honest
  /// message, or null when the bands are fine. The server 400s these too.
  String? _bandOrderError(int? payMin, int? payMax, int? expMin, int? expMax) {
    if (payMin != null && payMax != null && payMax < payMin) {
      return 'Max pay must be at least the min.';
    }
    if (expMin != null && expMax != null && expMax < expMin) {
      return 'Max experience must be at least the min.';
    }
    return null;
  }

  /// FOLD ONLY WHAT HAS NO COLUMN. `description` is the company posting's one
  /// free-text field, and #357 used it to carry every input the create route had
  /// no column for — trade, the pay band, the experience window and the
  /// free-text skills — because those were rendered and then silently discarded.
  ///
  /// #1646/#1648 gave the route REAL columns for the pay band, its pay type and
  /// the experience window, and they are now sent as such. Folding them here as
  /// well would print the same numbers twice on the worker's card: once as its
  /// own pay/experience chips, once inside the description blob. So the fold is
  /// down to the two things that STILL have no column of their own:
  ///
  ///  - the trade (no `trade_key` on the company contract — that is the agency
  ///    route's field), and
  ///  - the free-text "Key skills" of the V1-off fallback path (`skills` is
  ///    canonicalized server-side and never shown back verbatim; [_skills] is
  ///    only ever non-empty when the demand-skill picker is unavailable).
  ///
  /// Nothing is invented: an untouched form sends NO description (null), never a
  /// filler string.
  String? _companyDescription() {
    final List<String> lines = <String>[];
    final String? trade = _trade;
    if (trade != null) lines.add('Trade: $trade');
    if (_skills.isNotEmpty) lines.add('Key skills: ${_skills.join(', ')}');
    return lines.isEmpty ? null : lines.join('\n');
  }

  Future<void> _submit() async {
    if (_isAgency) {
      await _submitAgency();
      return;
    }

    final String org = _org.text.trim();
    final String title = _title.text.trim();
    if (org.isEmpty || title.isEmpty) {
      showBbToast(
        context,
        title: 'Add the basics',
        message: 'Company name and job title are needed.',
        icon: Icons.info_outline,
      );
      return;
    }

    final String? bandError = _bandOrderError(
      _intOrNull(_payMin.text),
      _intOrNull(_payMax.text),
      _intOrNull(_expMin.text),
      _intOrNull(_expMax.text),
    );
    if (bandError != null) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: bandError,
        icon: Icons.info_outline,
      );
      return;
    }

    // Defence in depth behind the disabled Post button: when the demand-skill
    // picker is live the job needs at least one skill so it can be matched to
    // workers (now, or as they join — reach is dynamic, see `_companyCanPost`).
    final bool v1 = _matchV1 == _MatchV1.available;
    if (v1 && _pickedSkillIds.isEmpty) {
      showBbToast(
        context,
        title: 'Pick a skill',
        message: 'Choose at least one skill this role needs so we can match it '
            'to workers.',
        icon: Icons.info_outline,
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final String location = _location.text.trim();
      // The structured display/match half of the posting. Computed ONCE so the
      // create and the repair PATCH below can never disagree.
      //
      // NOT gated on Matching V1: city / pay / shift / needed_by are the
      // posting's WORKER-VISIBLE display columns (migration 0054) and the PATCH
      // accepts them whether or not the match routes are on. Gating them meant a
      // `MATCH_V1_ENABLED=false` server stored no pay and no shift at all, so
      // every company job showed a worker a card with no wage and no timing.
      // Only the match SKILL ids below are V1-conditional.
      final String? city = location.isNotEmpty ? location : null;
      final String areaText = _area.text.trim();
      final String? area = areaText.isEmpty ? null : areaText;
      final int? payMin = _intOrNull(_payMin.text);
      final int? payMax = _intOrNull(_payMax.text);
      final String? payType = _payType;
      final int? expMin = _intOrNull(_expMin.text);
      final int? expMax = _intOrNull(_expMax.text);
      final String? shift = _shift;
      final String? neededBy = _companyNeededBy;
      // Copied, not aliased: the repair below re-sends these and the payer can
      // still be editing the form while the create is in flight.
      final List<String> benefits = List<String>.of(_benefits);
      final List<String> requirements = List<String>.of(_requirements);
      final List<String> matchSkillIds = v1
          ? _pickedSkillIds.toList(growable: false)
          : const <String>[];
      final List<String> untickedRelatedIds = v1
          ? _untickedRelatedIds.toList(growable: false)
          : const <String>[];

      final JobPosting draft = await locator<PayerApiClient>().createCompanyJob(
        orgLabel: org,
        roleTitle: title,
        locationLabel: location.isEmpty ? null : location,
        // #357 — carries the trade/pay/experience/skills the payer entered.
        description: _companyDescription(),
        vacancyBand: _band,
        // Matching V1 (additive) — only sent when the picker is live, so a
        // V1-off server never receives fields it does not understand.
        matchSkillIds: matchSkillIds.isEmpty ? null : matchSkillIds,
        untickedRelatedIds:
            untickedRelatedIds.isEmpty ? null : untickedRelatedIds,
        // City reuses the existing location field; area is its own coarse
        // bucket (never derived from the location label). Pay, pay type and the
        // experience window are sent as the structured columns they now are —
        // they are no longer folded into the free-text description.
        city: city,
        area: area,
        payMin: payMin,
        payMax: payMax,
        payType: payType,
        minExperienceYears: expMin,
        maxExperienceYears: expMax,
        shift: shift,
        neededBy: neededBy,
        // Untouched lists send NOTHING (there is nothing stored to clear).
        benefits: benefits.isEmpty ? null : benefits,
        requirements: requirements.isEmpty ? null : requirements,
      );

      // …and land whatever the create route dropped (see [_landDisplayFields]).
      final bool landed = await _landDisplayFields(
        draft,
        city: city,
        area: area,
        payMin: payMin,
        payMax: payMax,
        payType: payType,
        minExperienceYears: expMin,
        maxExperienceYears: expMax,
        shift: shift,
        neededBy: neededBy,
        benefits: benefits,
        requirements: requirements,
        matchSkillIds: matchSkillIds,
        untickedRelatedIds: untickedRelatedIds,
      );
      if (!mounted) return;
      showBbToast(
        context,
        title: 'Job posted',
        // Never a silent partial save: if the draft exists but its pay/shift/
        // skills did not land, say so and point at the edit screen that can fix
        // it. The draft is KEPT — posting again would duplicate it.
        message: landed
            ? 'Saved as a draft — publish it from My jobs.'
            : 'Draft saved, but the pay, shift and skills details did not. '
                'Open it from My jobs and edit to add them.',
        icon: landed ? Icons.check_circle : Icons.info_outline,
      );
      widget.onBack();
    } catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      _showPostFailure(error);
    }
  }

  /// OLD-SERVER FALLBACK — land whatever the create route DROPPED.
  ///
  /// `POST /payer/job-postings` used to validate against a
  /// `PayerCreateJobPostingSchema` that accepted ONLY org/role/location/
  /// description/vacancy/skills: Zod SILENTLY STRIPPED `city`, `area`, the pay
  /// band and its `pay_type`, the experience window, `shift`, `needed_by`,
  /// `benefits`, `requirements`, `match_skill_ids` and `unticked_related_ids`.
  /// So a payer who set a wage, a shift and five demand skills got a posting
  /// carrying NONE of it — and with no `match_skill_ids` the posting
  /// materialised NO reach, which means it reached NO worker at all (#1645).
  ///
  /// FIXED UPSTREAM in #1653: both create schemas now spread the same content +
  /// match blocks the PATCH does, so a current server persists everything on the
  /// 201 and this method finds nothing missing and makes NO second call. It is
  /// kept because an OLDER deployment (and the local API checkouts running
  /// behind `origin/main`) still strips them, and a posting that silently
  /// reaches nobody is the worst failure this app has.
  ///
  /// Driven off the RETURNED draft, never off a hard-coded assumption about the
  /// server's version: we patch exactly the fields the draft came back WITHOUT.
  /// Returns true when everything the payer entered is stored (the create kept
  /// it, or the PATCH landed it), false when the PATCH failed — the caller then
  /// tells the payer instead of pretending. The draft is never deleted on
  /// failure: it is a real posting, and create is not idempotent, so a retry
  /// would leave a duplicate behind.
  Future<bool> _landDisplayFields(
    JobPosting draft, {
    required String? city,
    required String? area,
    required int? payMin,
    required int? payMax,
    required String? payType,
    required int? minExperienceYears,
    required int? maxExperienceYears,
    required String? shift,
    required String? neededBy,
    required List<String> benefits,
    required List<String> requirements,
    required List<String> matchSkillIds,
    required List<String> untickedRelatedIds,
  }) async {
    final bool missingCity = city != null && draft.city == null;
    final bool missingArea = area != null && draft.area == null;
    final bool missingPayMin = payMin != null && draft.payMin == null;
    final bool missingPayMax = payMax != null && draft.payMax == null;
    final bool missingPayType = payType != null && draft.payType == null;
    final bool missingExpMin =
        minExperienceYears != null && draft.minExperienceYears == null;
    final bool missingExpMax =
        maxExperienceYears != null && draft.maxExperienceYears == null;
    final bool missingShift = shift != null && draft.shift == null;
    final bool missingNeededBy = neededBy != null && draft.neededBy == null;
    // A chip list counts as dropped only when we SENT one and the draft came
    // back with nothing stated. `[]` on the draft would mean the server stored
    // an empty list, which a create never does from this form.
    final bool missingBenefits =
        benefits.isNotEmpty && (draft.benefits?.isEmpty ?? true);
    final bool missingRequirements =
        requirements.isNotEmpty && (draft.requirements?.isEmpty ?? true);
    final bool missingSkills =
        matchSkillIds.isNotEmpty && draft.matchSkillIds.isEmpty;
    final bool missingAnything = missingCity ||
        missingArea ||
        missingPayMin ||
        missingPayMax ||
        missingPayType ||
        missingExpMin ||
        missingExpMax ||
        missingShift ||
        missingNeededBy ||
        missingBenefits ||
        missingRequirements ||
        missingSkills;
    if (!missingAnything) return true;

    // No id on the create response → there is nothing to PATCH against, and we
    // never guess one. Report honestly instead.
    final String? id = draft.id;
    if (id == null || id.isEmpty) return false;

    try {
      await locator<PayerApiClient>().updateJob(
        id,
        city: missingCity ? city : null,
        area: missingArea ? area : null,
        payMin: missingPayMin ? payMin : null,
        payMax: missingPayMax ? payMax : null,
        payType: missingPayType ? payType : null,
        minExperienceYears: missingExpMin ? minExperienceYears : null,
        maxExperienceYears: missingExpMax ? maxExperienceYears : null,
        shift: missingShift ? shift : null,
        neededBy: missingNeededBy ? neededBy : null,
        // Only ever a NON-EMPTY list here: an empty one would be sent as the
        // contract's "clear" instruction, which is not what a create dropping a
        // field means.
        benefits: missingBenefits ? benefits : null,
        requirements: missingRequirements ? requirements : null,
        // Reach is resolved server-side FROM these; the unticks only mean
        // anything alongside the picked skills, so they ride the same condition
        // (and only when the V1 picker was live, which is what a non-empty
        // [matchSkillIds] already encodes).
        matchSkillIds: missingSkills ? matchSkillIds : null,
        untickedRelatedIds: missingSkills && untickedRelatedIds.isNotEmpty
            ? untickedRelatedIds
            : null,
      );
      return true;
    } catch (_) {
      // Swallowed ON PURPOSE: the create SUCCEEDED, so this is a partial save,
      // not a failed post. The caller surfaces it as such.
      return false;
    }
  }

  /// Name the real reason where we know it: a 400 on either route means the
  /// server rejected the DETAILS themselves, which "check your connection" would
  /// misdescribe. The worker-visible free text is screened fail-closed on three
  /// things — contact details, a company name, and links — so the message names
  /// all three instead of only the first.
  void _showPostFailure(Object error) {
    final bool rejected = error is PayerApiException && error.isBadRequest;
    showBbToast(
      context,
      title: 'Could not post',
      message: rejected
          ? 'The server rejected these details. Take out any phone number, '
              'email address, company name or link.'
          : 'Something went wrong. Please try again.',
      icon: Icons.info_outline,
    );
  }

  /// AGENCY create — the faceless demand contract (`POST /payer/agency/jobs`).
  /// Sends `trade_key`/`title`/`city` (+ optional coarse `area`/pay/experience
  /// bands + `needed_by`). On success → toast + back to My-jobs (which refetches
  /// agency jobs). NEVER an org/employer name (no such field on this route).
  Future<void> _submitAgency() async {
    final String title = _title.text.trim();
    final String city = _city.text.trim();
    if (title.isEmpty || city.isEmpty) {
      showBbToast(
        context,
        title: 'Add the basics',
        message: 'Job title and city are needed.',
        icon: Icons.info_outline,
      );
      return;
    }

    final int? payMin = _intOrNull(_payMin.text);
    final int? payMax = _intOrNull(_payMax.text);
    final int? expMin = _intOrNull(_expMin.text);
    final int? expMax = _intOrNull(_expMax.text);
    // Client-side ordering check for an honest message (the server also 400s).
    final String? bandError =
        _bandOrderError(payMin, payMax, expMin, expMax);
    if (bandError != null) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: bandError,
        icon: Icons.info_outline,
      );
      return;
    }

    // Worker-visible free text: screened before the call so one bad line does not
    // 400 the whole post (the chips are already screened at entry).
    final String description = _description.text.trim();
    final String? descriptionError = postingDescriptionError(description);
    if (descriptionError != null) {
      showBbToast(
        context,
        title: 'Check the description',
        message: descriptionError,
        icon: Icons.info_outline,
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final String area = _area.text.trim();
      await locator<PayerApiClient>().createAgencyJob(
        tradeKey: _tradeKey,
        title: title,
        city: city,
        area: area.isEmpty ? null : area,
        payMin: payMin,
        payMax: payMax,
        // Unpicked → nothing sent: the card then shows the band with no
        // pay-type pill rather than a guessed "in-hand" (#1648).
        payType: _payType,
        minExperienceYears: expMin,
        maxExperienceYears: expMax,
        neededBy: _neededBy,
        // The worker-visible half of the card. Untouched inputs send NOTHING
        // (null / omitted), never a filler string or a placeholder chip.
        description: description.isEmpty ? null : description,
        shift: _shift,
        benefits: _benefits.isEmpty ? null : List<String>.of(_benefits),
        requirements:
            _requirements.isEmpty ? null : List<String>.of(_requirements),
      );
      if (!mounted) return;
      showBbToast(
        context,
        title: 'Job posted',
        message: 'Live now — see it under My jobs.',
      );
      widget.onBack();
    } catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      _showPostFailure(error);
    }
  }

  /// #357 — '+ Add skill' used to insert the literal placeholder 'Skill N', so
  /// the chip row was decorative. It now prompts for the real phrase, bounded to
  /// the server's `skillsInput` limits and screened for contact details.
  Future<void> _addSkill() => _addPhrase(
        into: _skills,
        noun: 'skill',
        maxChars: _maxSkillChars,
        dialogTitle: 'Add a skill',
        hint: 'e.g. Fanuc, VMC setting',
        fieldKey: const Key('add-skill-field'),
      );

  /// One worker-visible benefit chip (agency `benefits[]`, <=80 chars each).
  Future<void> _addBenefit() => _addPhrase(
        into: _benefits,
        noun: 'benefit',
        maxChars: JobContentLimits.listItemChars,
        dialogTitle: 'Add a benefit',
        hint: 'e.g. PF + ESI, canteen',
        fieldKey: const Key('add-benefit-field'),
      );

  /// One worker-visible requirement chip (agency `requirements[]`, <=80 each).
  Future<void> _addRequirement() => _addPhrase(
        into: _requirements,
        noun: 'requirement',
        maxChars: JobContentLimits.listItemChars,
        dialogTitle: 'Add a requirement',
        hint: 'e.g. Fanuc control, ITI fitter',
        fieldKey: const Key('add-requirement-field'),
      );

  /// Prompt for a phrase (shared rules: cap + PII screen live in
  /// [promptForPostingPhrase]) and append it to [into] when it is accepted and
  /// new. A refused or cancelled prompt changes nothing.
  Future<void> _addPhrase({
    required List<String> into,
    required String noun,
    required int maxChars,
    required String dialogTitle,
    required String hint,
    required Key fieldKey,
  }) async {
    final String? phrase = await promptForPostingPhrase(
      context,
      noun: noun,
      maxChars: maxChars,
      title: dialogTitle,
      hint: hint,
      fieldKey: fieldKey,
    );
    if (!mounted || phrase == null || into.contains(phrase)) return;
    setState(() => into.add(phrase));
  }

  @override
  Widget build(BuildContext context) {
    // Transparent so this inner Scaffold never paints over the shell surface —
    // it exists only to pin the primary action below a form that can outgrow the
    // fold (mirrors edit_agency_job_screen).
    return Scaffold(
      backgroundColor: Colors.transparent,
      bottomNavigationBar: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s3,
            AppSpacing.gutter,
            AppSpacing.s3,
          ),
          child: BbButton(
            label: 'Post job',
            iconLeft: Icons.send,
            block: true,
            loading: _submitting,
            // Disabled (null) for the company path until at least one demand skill
            // is picked (reach is not required — it is dynamic); the agency path
            // is never gated here.
            onPressed: (_isAgency || _companyCanPost) ? _submit : null,
          ),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter,
          AppSpacing.s2,
          AppSpacing.gutter,
          AppSpacing.s6,
        ),
        children: <Widget>[
          Row(
            children: <Widget>[
              BbIconButton(
                icon: Icons.arrow_back,
                semanticLabel: 'Back',
                onPressed: widget.onBack,
              ),
              const SizedBox(width: AppSpacing.s3),
              Text(
                'Post a job',
                style: AppTypography.display(
                  size: AppTypography.sizeLg,
                  weight: FontWeight.w800,
                ),
              ),
              const Spacer(),
              const BbBadge('Free', tone: BbBadgeTone.success),
            ],
          ),
          const SizedBox(height: AppSpacing.s4),
          // Branch on the locked session role: the agency posts to a DIFFERENT
          // (faceless demand) contract that DOES accept trade/pay/experience.
          ...(_isAgency ? _agencyFields() : _companyFields()),
        ],
      ),
    );
  }

  /// A JUL31 section card — paper, 1px hairline, radius 10, elevation 0 — with a
  /// deep-blue Anek section title. Uses a [ListBody] (never a [Column]) as its
  /// vertical wrapper so the only [Column] ancestor of a field label stays the
  /// field's own — the form tests locate an input by that ancestor.
  Widget _sectionCard(String title, List<Widget> children) => BbCard(
        child: ListBody(
          children: <Widget>[
            Text(
              title,
              style: AppTypography.display(
                size: AppTypography.sizeMd,
                weight: FontWeight.w800,
                color: AppColors.blue,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            ...children,
          ],
        ),
      );

  /// A labelled single-select rendered as aligned kit chips (the JUL31 pattern
  /// for enum choices) — selected flips to a solid haldi pill. Carries the same
  /// value/onChanged contract the old [BbSelect] did, so submit logic is intact.
  Widget _chipField<T>({
    required String label,
    required T value,
    required List<T> options,
    required String Function(T) labelOf,
    required ValueChanged<T> onSelected,
  }) =>
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final T option in options)
                BbChip(
                  label: labelOf(option),
                  selected: option == value,
                  onTap: () => onSelected(option),
                ),
            ],
          ),
        ],
      );

  /// The pay-type selector, shared by both branches (`pay_type`, #1648) — what
  /// the ₹ band the payer just typed actually MEANS to the worker. Offered
  /// straight under the band for that reason.
  Widget _payTypeField() => _chipField<String?>(
        label: 'Pay type',
        value: _payType,
        options: const <String?>[null, ...kJobPayTypes],
        labelOf: _payTypeLabel,
        onSelected: (String? v) => setState(() => _payType = v),
      );

  /// `in_hand|gross|ctc` → display labels; null = "Not stated".
  ///
  /// NOT the Needed-by card's "Not set": two different unset states on one form
  /// must read differently. An unpicked pay type sends NOTHING, so the worker's
  /// card shows the band with no pay-type pill — the platform never guesses
  /// net-vs-gross, and "kitna haath me aayega" is the worker's first question.
  static String _payTypeLabel(String? v) => jobPayTypeLabel(v) ?? 'Not stated';

  /// COMPANY posting inputs. #357: every input here now reaches
  /// `POST /payer/job-postings` — org/title/location/vacancy band as their own
  /// columns, and trade + pay + experience + skills folded into the free-text
  /// `description` (see [_companyDescription]), because that route has no typed
  /// column for them. Nothing on this form is prefilled and nothing is dropped.
  List<Widget> _companyFields() => <Widget>[
        _sectionCard('Company & role', <Widget>[
          BbField(
            label: 'Company / org name',
            controller: _org,
            // Identity name field: keep the keyboard from resurfacing an org
            // name typed in another app (matches signup + account, #1227).
            suppressSuggestions: true,
          ),
          const SizedBox(height: AppSpacing.s4),
          BbField(
            label: 'Job title',
            controller: _title,
            hint: 'e.g. CNC Setter',
          ),
          const SizedBox(height: AppSpacing.s4),
          // Null until picked — a preselected trade would land in `description`
          // without the payer ever choosing it (#357). A dropdown (not a chip
          // grid) so the unpicked trade names are not surfaced on the form.
          BbSelect<String?>(
            label: 'Trade (optional)',
            value: _trade,
            items: <String?>[null, ..._trades],
            labelOf: (String? t) => t ?? 'Not specified',
            onChanged: (String? v) => setState(() => _trade = v),
          ),
          const SizedBox(height: AppSpacing.s4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: BbField(
                  label: 'Location',
                  controller: _location,
                  hint: 'optional',
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                // COARSE locality bucket, typed by the payer — deliberately NOT
                // derived from Location: the server keeps `area` and the
                // free-text `location_label` apart on purpose.
                child: BbField(
                  label: 'Area (optional)',
                  controller: _area,
                  hint: 'e.g. Chakan',
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s4),
          _chipField<String>(
            label: 'Vacancies',
            value: _band,
            options: _bands,
            labelOf: (String b) => b,
            onSelected: (String v) => setState(() => _band = v),
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        // Whole rupees, not free text — and sent as the posting's own pay
        // columns (#1646), no longer folded into the description.
        _sectionCard('Pay, experience & timing', <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: BbField(
                  label: 'Pay min ₹/mo',
                  controller: _payMin,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbField(
                  label: 'Pay max ₹/mo',
                  controller: _payMax,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s4),
          _payTypeField(),
          const SizedBox(height: AppSpacing.s4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: BbField(
                  label: 'Exp min (yrs)',
                  controller: _expMin,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbField(
                  label: 'Exp max (yrs)',
                  controller: _expMax,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s4),
          // Shift + needed-by are worker-visible DISPLAY columns, not match
          // inputs, so they live here and are offered whether or not Matching
          // V1 is on. Null stays "Any shift" / "Not specified": an unpicked
          // value sends nothing, so the worker's card never claims a timing the
          // payer did not choose.
          _chipField<String?>(
            label: 'Shift',
            value: _shift,
            options: const <String?>[null, 'day', 'night', 'rotational'],
            labelOf: _shiftLabel,
            onSelected: (String? v) => setState(() => _shift = v),
          ),
          const SizedBox(height: AppSpacing.s4),
          _chipField<String?>(
            label: 'Needed by',
            value: _companyNeededBy,
            options: const <String?>[null, 'immediate', 'soon', 'flexible'],
            labelOf: _companyNeededByLabel,
            onSelected: (String? v) => setState(() => _companyNeededBy = v),
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        // Matching V1: the demand-skill picker + reach meter when the route is
        // live; the free-text skills flow otherwise (see [_companySkillsSection]).
        _sectionCard('Skills & matching', _companySkillsSection()),
        const SizedBox(height: AppSpacing.s4),
        // The worker-visible chips. #1646 gave the company posting the same
        // `benefits`/`requirements` columns the agency route had, so these reach
        // the job card verbatim instead of having nowhere to go. Same caps and
        // the same entry screen as the agency form (one shared widget).
        _sectionCard('What workers see', <Widget>[
          Text(
            'Shown on the job card exactly as you type it. Leave out company '
            'names, phone numbers and links.',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
              height: 1.45,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          _chipListField(
            label: 'Benefits (optional)',
            values: _benefits,
            maxItems: JobContentLimits.listItems,
            addLabel: '+ Add benefit',
            onAdd: _addBenefit,
          ),
          const SizedBox(height: AppSpacing.s4),
          _chipListField(
            label: 'Requirements (optional)',
            values: _requirements,
            maxItems: JobContentLimits.listItems,
            addLabel: '+ Add requirement',
            onAdd: _addRequirement,
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        Container(
          padding: const EdgeInsets.all(AppSpacing.s3),
          decoration: BoxDecoration(
            color: AppColors.successTint,
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: AppColors.success, width: 1.5),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Icon(Icons.verified_user,
                  size: 22, color: AppColors.green700),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: RichText(
                  text: TextSpan(
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.green700,
                      height: 1.45,
                    ),
                    children: <InlineSpan>[
                      const TextSpan(
                        text: 'Confirm this is a real, open role. ',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      const TextSpan(
                        text: 'We verify before workers see it — ghost jobs '
                            'waste swipes. ',
                      ),
                      const TextSpan(
                        text: "You'll get a Verified job badge once approved. "
                            'Posting is free.',
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        // #357 — this was a live-looking 'Boost this posting' toggle that the
        // create call never read. Boost really is a separate paid action
        // (`POST /payer/job-postings/:id/boost`) on an existing posting, so we
        // say where it lives instead of faking a switch here.
        Text(
          'Boost and applicant plans are bought from My jobs once this posting '
          'is published.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
            height: 1.45,
          ),
        ),
      ];

  /// The COMPANY skills area, branched on Matching-V1 availability:
  ///  - [_MatchV1.loading]     — a small placeholder while `fetchMatchSkills()`
  ///    resolves (Post is held disabled meanwhile).
  ///  - [_MatchV1.available]   — the closed-taxonomy picker + live reach meter.
  ///    (Shift / Needed-by are NOT here: they are display columns, offered on
  ///    the Pay & timing card regardless of V1.)
  ///  - [_MatchV1.unavailable] — the pre-existing free-text "Key skills" flow,
  ///    so posting still works when the route is off (`MATCH_V1_ENABLED` false).
  List<Widget> _companySkillsSection() {
    switch (_matchV1) {
      case _MatchV1.loading:
        return <Widget>[_skillsLoading()];
      case _MatchV1.unavailable:
        return _freeTextSkills();
      case _MatchV1.available:
        return <Widget>[
          MatchSkillPicker(
            skills: _matchSkills,
            pickedIds: _pickedSkillIds,
            untickedRelatedIds: _untickedRelatedIds,
            reach: _reach,
            reachLoading: _reachLoading,
            reachFailed: _reachFailed,
            onRetryReach: _loadReach,
            maxSkills: _maxSkillsPerPosting,
            onToggleSkill: _onToggleSkill,
            onToggleRelated: _onToggleRelated,
          ),
        ];
    }
  }

  /// Placeholder shown while the demand-skill set loads.
  Widget _skillsLoading() => Container(
        padding: const EdgeInsets.all(AppSpacing.s3),
        decoration: BoxDecoration(
          color: AppColors.surfaceSunken,
          borderRadius: BorderRadius.circular(AppRadii.md),
          border: Border.all(color: AppColors.borderDefault),
        ),
        child: Row(
          children: <Widget>[
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppColors.textMuted,
              ),
            ),
            const SizedBox(width: AppSpacing.s2),
            Text(
              'Loading matching skills…',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
          ],
        ),
      );

  /// The V1-off fallback — the pre-existing free-text "Key skills" chips. These
  /// ride the create call folded into `description` (see [_companyDescription]).
  List<Widget> _freeTextSkills() => <Widget>[
        _chipListField(
          label: 'Key skills',
          values: _skills,
          maxItems: _maxSkills,
          addLabel: '+ Add skill',
          onAdd: _addSkill,
        ),
      ];

  /// One payer-typed chip list, bound to this screen's state (the widget itself
  /// is shared with the edit screens — see [JobChipListField]).
  Widget _chipListField({
    required String label,
    required List<String> values,
    required int maxItems,
    required String addLabel,
    required Future<void> Function() onAdd,
  }) =>
      JobChipListField(
        label: label,
        values: values,
        maxItems: maxItems,
        addLabel: addLabel,
        onAdd: onAdd,
        onRemove: (String value) => setState(() => values.remove(value)),
      );

  /// "day/night/rotational" → display labels; null = the honest "Any" default.
  static String _shiftLabel(String? v) {
    switch (v) {
      case 'day':
        return 'Day';
      case 'night':
        return 'Night';
      case 'rotational':
        return 'Rotational';
      default:
        return 'Any shift';
    }
  }

  /// "immediate/soon/flexible" → display labels; null = "Not specified".
  static String _companyNeededByLabel(String? v) {
    switch (v) {
      case 'immediate':
        return 'Immediately';
      case 'soon':
        return 'Within weeks';
      case 'flexible':
        return 'Flexible';
      default:
        // NOT the Trade select's "Not specified": two different unset states on
        // one form must read differently, and an unset timing sends no
        // `needed_by` at all rather than a fabricated "flexible".
        return 'Not set';
    }
  }

  /// AGENCY posting inputs — every field here IS sent to `POST /payer/agency/
  /// jobs` (trade_key/title/city + optional coarse area/pay/experience bands +
  /// needed_by + the worker-visible description/shift/benefits/requirements).
  /// No org/employer name — that is not a demand attribute, and the server
  /// rejects one typed into any free-text field.
  List<Widget> _agencyFields() => <Widget>[
        _sectionCard('Job details', <Widget>[
          _chipField<String>(
            label: 'Trade',
            value: _tradeKey,
            options: kAgencyTradeKeys,
            labelOf: agencyTradeLabel,
            onSelected: (String v) => setState(() => _tradeKey = v),
          ),
          const SizedBox(height: AppSpacing.s4),
          BbField(label: 'Job title', controller: _title),
          const SizedBox(height: AppSpacing.s4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                // #357 — was prefilled 'Pune' (and area 'Chakan'); the agency
                // route is just as real, so these start empty too.
                child: BbField(
                  label: 'City',
                  controller: _city,
                  hint: 'e.g. Pune',
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbField(
                  label: 'Area (optional)',
                  controller: _area,
                ),
              ),
            ],
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        _sectionCard('Pay, experience & timing', <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: BbField(
                  label: 'Pay min ₹/mo',
                  controller: _payMin,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbField(
                  label: 'Pay max ₹/mo',
                  controller: _payMax,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s4),
          _payTypeField(),
          const SizedBox(height: AppSpacing.s4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: BbField(
                  label: 'Exp min (yrs)',
                  controller: _expMin,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Expanded(
                child: BbField(
                  label: 'Exp max (yrs)',
                  controller: _expMax,
                  hint: 'optional',
                  keyboardType: TextInputType.number,
                  mono: true,
                ),
              ),
            ],
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        _sectionCard('Timing', <Widget>[
          _chipField<String>(
            label: 'Needed by',
            value: _neededBy,
            options: kAgencyNeededBy,
            labelOf: agencyNeededByLabel,
            onSelected: (String v) => setState(() => _neededBy = v),
          ),
          const SizedBox(height: AppSpacing.s4),
          // Null stays "Any shift" — an unpicked shift sends nothing, so the
          // worker's card never claims a shift the payer did not choose.
          _chipField<String?>(
            label: 'Shift',
            value: _shift,
            options: const <String?>[null, 'day', 'night', 'rotational'],
            labelOf: _shiftLabel,
            onSelected: (String? v) => setState(() => _shift = v),
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        // The worker-visible content block. Everything here is rendered VERBATIM
        // on the worker's job card, so the copy says so and the inputs are
        // screened at entry (contact details / company names / links are 400s).
        _sectionCard('What workers see', <Widget>[
          Text(
            'Shown on the job card exactly as you type it. Leave out company '
            'names, phone numbers and links.',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
              height: 1.45,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          JobDescriptionField(controller: _description),
          const SizedBox(height: AppSpacing.s4),
          _chipListField(
            label: 'Benefits (optional)',
            values: _benefits,
            maxItems: JobContentLimits.listItems,
            addLabel: '+ Add benefit',
            onAdd: _addBenefit,
          ),
          const SizedBox(height: AppSpacing.s4),
          _chipListField(
            label: 'Requirements (optional)',
            values: _requirements,
            maxItems: JobContentLimits.listItems,
            addLabel: '+ Add requirement',
            onAdd: _addRequirement,
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        Container(
          padding: const EdgeInsets.all(AppSpacing.s3),
          decoration: BoxDecoration(
            color: AppColors.infoTint,
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: AppColors.info, width: 1.5),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Icon(Icons.info_outline, size: 22, color: AppColors.bluePressed),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  'Pay & experience are optional bands — they only help us match '
                  'the right workers. Posting is free.',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.bluePressed,
                    height: 1.45,
                  ),
                ),
              ),
            ],
          ),
        ),
      ];
}
