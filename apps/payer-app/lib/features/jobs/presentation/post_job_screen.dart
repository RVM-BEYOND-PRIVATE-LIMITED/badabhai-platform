import 'dart:async';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/data/payer_api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/session/app_session.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_haptics.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/number_input.dart';
import '../../../core/widgets/bb_action_bar.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_chip_select.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_field_error.dart';
import '../../../core/widgets/bb_focus_chain.dart';
import '../../../core/widgets/bb_form_errors.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_leave_guard.dart';
import '../../../core/widgets/bb_shake.dart';
import '../../../core/widgets/bb_step_progress.dart';
import '../../../core/widgets/bb_toast.dart';
import 'widgets/job_content_input.dart';
import 'widgets/job_form_rules.dart';
import 'widgets/match_skill_picker.dart';
import 'widgets/trade_posting_fields.dart';

/// Availability of the Matching-V1 demand-skill vocabulary, resolved once at
/// load.
///
///  - [loading]     — `fetchMatchSkills()` in flight; Post is held until known.
///  - [available]   — the route answered with skills. The AGENCY form shows
///    the picker + reach meter; the company form sends its trade's derived
///    match skills alongside the trade form.
///  - [unavailable] — the route is off server-side (`MATCH_V1_ENABLED` false →
///    404/error) or returned nothing; the agency form hides the picker, and
///    the company form sends no `match_skill_ids` (the server still derives
///    them from the trade form).
enum _MatchV1 { loading, available, unavailable }

/// Post a job — role-branched on [AppSession.role].
///
///  - COMPANY: `POST /payer/job-postings` (201 draft; publish it later from
///    My-jobs) accepts `org_label`, `role_title`, optional `location_label`,
///    the typed `description`, EXACTLY ONE of `vacancy_band | vacancies`, the
///    worker-visible content columns since #1646/#1648 (`city`, `area`,
///    `pay_min`/`pay_max`/`pay_type`, `min_experience_years`/
///    `max_experience_years`, `shift`, `needed_by`, `benefits`,
///    `requirements`), and the TRADE: `role_kind` plus its trade form
///    (`trade_level` / `trade_answers`, migration 0141), from which the server
///    derives the match skills. #2635 — a company job matches only within the
///    16 postable trades and cannot be published without one (the server drops
///    any skill outside the trade), so the trade is REQUIRED and is always
///    picked from the 16-trade catalogue: if that does not load, the form says
///    why and offers Retry — it never falls back to a free role list, the flat
///    skill picker or free-text skills. Nothing is prefilled: every free-text
///    input starts empty (#357).
///  - AGENCY: sends the faceless demand attributes the agent route accepts —
///    `trade_key`, `title`, `city`, optional `area`, `pay_min`/`pay_max`,
///    `pay_type`, `min_experience_years`/`max_experience_years`, `needed_by`,
///    plus the worker-visible `description`/`shift`/`benefits`/`requirements` —
///    to `POST /payer/agency/jobs` (201 → live `open`; refetch My-jobs). Unlike
///    the company route, agency DOES take the trade as a typed column.
///    NEVER an employer name or worker identity (no such field on this contract).
///
/// #2595 (M7) — a refused post shows every reason AT its field and takes the
/// payer to the first one (scroll + shake + error haptic) instead of a toast;
/// the pay/experience boxes are digits-only (₹-prefixed and grouped for pay);
/// the keyboard's "next" walks the text boxes; a drag closes the keyboard; the
/// Post button sits in the shared pinned [BbActionBar]; a progress bar counts
/// the four sections done; and leaving with anything entered asks first
/// ([BbLeaveGuard] — the shell asks the same for the system Back).
class PostJobScreen extends StatefulWidget {
  const PostJobScreen({super.key, required this.onBack, this.onPosted});

  final VoidCallback onBack;

  /// Called with the new posting's id after a successful post, IN PLACE of
  /// [onBack] — the shell lands on Jobs with that card highlighted (#2596).
  /// Null keeps the old hand-off: [onBack].
  final ValueChanged<String>? onPosted;

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

  // --- The city bucket — BOTH branches --------------------------------------
  // The worker's card draws its place row from `city` (+ the coarse `area`), so
  // both routes need one. The company form used to have NO city input at all:
  // `_submit` reused the free-text Location box, which is `location_label` —
  // poster free text the feed deliberately never reads. A payer who typed
  // "Plot 42, MIDC" stored that as his city, and one who left Location blank
  // published a posting with NO city, which the feed serves as "" and the card
  // draws as a bare location pin with nothing beside it.
  final TextEditingController _city = TextEditingController();

  // COARSE locality bucket ("Chakan"), shared by both branches (#1646 gave the
  // company create an `area` column too). NEVER an address, and never derived
  // from the company form's free-text Location — the server keeps that wall on
  // purpose, so the payer types this one himself.
  final TextEditingController _area = TextEditingController();

  // --- Worker-visible content (BOTH branches now) ---------------------------
  // `description` / `shift` / `benefits` / `requirements` — the fields the
  // WORKER's job card renders verbatim. The agency create always accepted them;
  // #1646 gave the company create `benefits`/`requirements` as real columns too.
  // Shift reuses the shared [_shift]; one branch is ever mounted, like the pay
  // bands. #357: nothing is prefilled, an untouched input sends nothing, and a
  // chip is only ever a phrase the payer typed.
  final TextEditingController _description = TextEditingController();
  final List<String> _benefits = <String>[];
  final List<String> _requirements = <String>[];

  /// The server's `vacancy_band` enum — exact values the route accepts.
  static const List<String> _bands = <String>[
    '1',
    '2-5',
    '6-10',
    '11-25',
    '25+'
  ];

  /// The declared role kind (`role_kind`). For a COMPANY job it is the TRADE —
  /// one of the 16 the catalogue lists, required (#2635): the server builds the
  /// job's match skills from it. For an agency job it picks the worker card's
  /// role illustration. Null = not picked yet.
  String? _roleKind;
  String _band = '2-5';
  // Agency `trade_key` enum + coarse `needed_by` timing (server-accepted
  // values). BOTH start NULL. The trade is the worker card's own trade line and
  // the timing is its "Turant chahiye" chip, so a preselected first option would
  // print a fact on that card the payer never chose (#357) — and a default is
  // exactly how every agency job ended up advertising the same trade. Required
  // at submit, like every other field the card renders.
  String? _tradeKey;
  String? _neededBy;
  bool _submitting = false;

  // --- #2595 (M7) — inline errors, keyboard flow, the leave guard -----------

  /// What is wrong and where; see [_validate].
  final BbFormErrors<JobFormField> _form = BbFormErrors<JobFormField>();

  /// The keyboard's "next" through the text boxes, in the order they are drawn
  /// (the branch is locked at login, so one chain per form). It ends — "done" —
  /// on the last experience box: the chips that follow need a tap, so the
  /// keyboard steps aside for them.
  late final BbFocusChain<JobFormField> _chain;

  /// Every text box, merged — typing does not rebuild the form, so this is what
  /// the progress bar, the inline errors and the leave guard listen to.
  late final Listenable _inputs;

  /// The form as it opened (the org is prefilled) — [_hasUnsavedChanges]
  /// compares against it.
  late final List<Object?> _pristine;

  /// True once the post went through: nothing on the form is unsaved after.
  bool _posted = false;

  /// A trade chip refused at the match-skill cap, explained under the trade
  /// fields; cleared by the next accepted change.
  String? _skillCapError;

  static const BbLeavePrompt _leavePrompt = BbLeavePrompt(
    title: 'Discard this job?',
    message: 'What you have filled in here will be lost.',
  );

  // --- Matching V1 ------------------------------------------------------------
  // The demand-skill vocabulary + live reach meter. All additive: see
  // [_MatchV1] for what each branch does when the route is off.

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

  // --- Migration 0141 — the role-specific trade form -------------------------
  List<PostingTradeForm> _postingTrades = const <PostingTradeForm>[];
  bool _postingTradesLoading = true;

  /// Why the last catalogue load failed (said at the company trade picker),
  /// or null.
  PayerFailure? _postingTradesFailure;
  String _tradeLevel = '';
  Map<String, List<String>> _tradeAnswers = const <String, List<String>>{};

  /// Coarse structured demand attributes. Null = "not set", so we never
  /// fabricate a shift/timing the payer did not choose (#357).
  String? _shift;
  String? _companyNeededBy;

  /// What the ₹ band MEANS — `in_hand|gross|ctc` (#1648), shared by both
  /// branches. Null is the ONLY honest default: the platform never guesses
  /// net-vs-gross, so an unpicked pay type sends nothing and the worker's card
  /// shows the band with no pay-type pill.
  String? _payType;

  bool get _isAgency => locator<AppSessionCubit>().state?.isAgency ?? false;

  @override
  void initState() {
    super.initState();
    // org_label is required by the company route; default it to the org this
    // account PUBLISHES under (editable) so the posting is attributed to the
    // right org.
    //
    // #2194 (ADR-0053 O-10) — that is `postingOrgName`, not the account name. A
    // recruiter on a team posts on the team's behalf, so a posting defaulted to
    // their own account label named the wrong company on a worker-facing card.
    // Falls back to the account name when the field is absent (an older API) or
    // null (tenancy refuses this payer), which is this screen's old behaviour.
    final String orgName =
        postingOrgLabelFor(locator<AppSessionCubit>().state?.account);
    _org = TextEditingController(text: orgName);
    _chain = BbFocusChain<JobFormField>(
      _isAgency
          ? const <JobFormField>[
              JobFormField.title,
              JobFormField.city,
              JobFormField.area,
              JobFormField.payMin,
              JobFormField.payMax,
              JobFormField.expMin,
              JobFormField.expMax,
            ]
          : const <JobFormField>[
              JobFormField.org,
              JobFormField.title,
              JobFormField.city,
              JobFormField.area,
              JobFormField.location,
              JobFormField.payMin,
              JobFormField.payMax,
              JobFormField.expMin,
              JobFormField.expMax,
            ],
    );
    _inputs = Listenable.merge(_textBoxes);
    _inputs.addListener(_onInputChanged);
    _pristine = _snapshot();
    // The closed-taxonomy vocabulary (ADR-0050: a V1 twin is served only on
    // skills the agent picked). Load it lazily and fail soft: any error (route
    // disabled, network) drops to `unavailable` — the AGENCY branch then hides
    // its picker (its skills can only ride `match_skill_ids`; #1960/#1957).
    // ignore: discarded_futures — fire-and-forget load; state updates on done.
    _loadMatchSkills();
    // ignore: discarded_futures — the 16-trade form catalogue. The company
    // form cannot post without it (#2635), so its failure is said, not hidden.
    _loadPostingTrades();
  }

  @override
  void dispose() {
    _reachDebounce?.cancel();
    _inputs.removeListener(_onInputChanged);
    _chain.dispose();
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
  /// an empty set — we mark V1 [unavailable]: the AGENCY form hides its skills
  /// section (the flat picker and its reach meter), and the COMPANY form sends
  /// no `match_skill_ids` — the server derives them from the trade form
  /// (#2635). Never throws to the tree.
  Future<void> _loadMatchSkills() async {
    try {
      final List<MatchSkill> skills =
          await locator<PayerApiClient>().fetchMatchSkills();
      if (!mounted) return;
      setState(() {
        _matchSkills = skills;
        _matchV1 = skills.isEmpty ? _MatchV1.unavailable : _MatchV1.available;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _matchV1 = _MatchV1.unavailable);
    }
  }

  /// Load — or, from Retry, reload — the 16-trade posting catalogue. Never a
  /// crash. #2635 — a failure no longer degrades the COMPANY form to a free
  /// role list and the flat skill picker (a job posted that way could never go
  /// live): its trade picker names the cause and offers Retry, and Post is
  /// refused at it. The agency form keeps its trade-less fallback.
  Future<void> _loadPostingTrades() async {
    if (!_postingTradesLoading) setState(() => _postingTradesLoading = true);
    List<PostingTradeForm> trades = const <PostingTradeForm>[];
    PayerFailure? failure;
    try {
      trades = await locator<PayerApiClient>().fetchPostingTrades();
    } catch (error) {
      failure = PayerFailure.from(error);
    }
    if (!mounted) return;
    setState(() {
      _postingTrades = trades;
      _postingTradesFailure = failure;
      _postingTradesLoading = false;
    });
  }

  PostingTradeForm? _formForKind(String? kind) {
    if (kind == null) return null;
    for (final PostingTradeForm trade in _postingTrades) {
      if (trade.roleKind == kind) return trade;
    }
    return null;
  }

  PostingTradeForm? get _tradeForm => _formForKind(_roleKind);

  /// The role picker is the single entry point to every trade field. Selecting a
  /// role resets the previous role's answers and seeds the base match skill.
  ///
  /// #2635 — for a company job this is the TRADE picker, and it is always on
  /// the form: while the catalogue loads, or if it did not, the same spot says
  /// so (with a Retry) and carries the role's inline error, so a post refused
  /// for want of a trade is told why where the trade goes.
  Widget _roleField() {
    if (_postingTradesLoading || _postingTrades.isEmpty) {
      return PostingTradePickerPlaceholder(
        loading: _postingTradesLoading,
        failure: _postingTradesFailure,
        onRetry: _loadPostingTrades,
        errorText: _form[JobFormField.role],
      );
    }
    return BbSelect<String?>(
      label: kPostingTradePickerLabel,
      value: _roleKind,
      items: <String?>[
        null,
        ..._postingTrades.map((PostingTradeForm t) => t.roleKind)
      ],
      labelOf: (String? kind) =>
          _formForKind(kind)?.roleLabel ?? '— pick the role —',
      errorText: _form[JobFormField.role],
      onChanged: (String? kind) {
        final PostingTradeForm? form = _formForKind(kind);
        setState(() {
          _roleKind = kind;
          _skillCapError = null;
          _tradeLevel = '';
          _tradeAnswers = const <String, List<String>>{};
          _pickedSkillIds
            ..clear()
            ..addAll(form?.matchSkillIdsFor(const <String, List<String>>{}) ??
                const <String>[]);
        });
        if (_pickedSkillIds.isEmpty) {
          _reachDebounce?.cancel();
          setState(() => _reach = null);
        } else {
          _scheduleReach();
        }
      },
    );
  }

  Widget _tradeSection() {
    final PostingTradeForm? form = _tradeForm;
    if (form == null) {
      return Text(
        'Pick a role above and the facts that role is hired on appear here.',
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textMuted,
          height: 1.45,
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        TradePostingFields(
          trade: form,
          tradeLevel: _tradeLevel,
          answers: _tradeAnswers,
          onChanged: (String level, Map<String, List<String>> answers) {
            final List<String> nextMatch = form.matchSkillIdsFor(answers);
            // The server posts at most `match_config.max_skills_per_posting` skills (base
            // + match chips). Refuse the tap here with the reason rather than failing the
            // publish later; the live cap arrives with the first reach preview.
            if (nextMatch.length > _maxSkillsPerPosting) {
              // #2595 — said under the chips that were tapped, not in a toast.
              // ignore: discarded_futures — fire-and-forget double tick.
              AppHaptics.error();
              setState(
                () => _skillCapError = matchSkillCapError(_maxSkillsPerPosting),
              );
              return;
            }
            setState(() {
              _skillCapError = null;
              _tradeLevel = level;
              _tradeAnswers = answers;
              _pickedSkillIds
                ..clear()
                ..addAll(nextMatch);
            });
            if (_pickedSkillIds.isEmpty) {
              _reachDebounce?.cancel();
              setState(() => _reach = null);
            } else {
              _scheduleReach();
            }
          },
        ),
        BbFieldError(text: _skillCapError),
        if (_reach != null) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          Text(
            _reach!.zeroReach
                ? 'No worker matches these yet — you can still post.'
                : 'Reaches ${_reach!.reachTotal} '
                    '${_reach!.reachTotal == 1 ? "worker" : "workers"}',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: _reach!.zeroReach
                  ? AppColors.warning
                  : AppColors.textSecondary,
            ),
          ),
        ],
      ],
    );
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
    _reachDebounce = Timer(const Duration(milliseconds: 350), _loadReach);
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
      final ReachPreview preview = await locator<PayerApiClient>().reachPreview(
        matchSkillIds: ids,
        untickedRelatedIds: _untickedRelatedIds.toList(growable: false),
        // #2635 — a company job's trade, so "reaches N workers" scopes the
        // posted skills exactly as its publish will. Agency jobs are not
        // scoped by trade, so their preview stays as it was.
        roleKind: _isAgency ? null : _roleKind,
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

  /// Whether the company skills section is complete: a trade is picked from
  /// the catalogue, which seeds its own match skill (#2635 — a company job's
  /// match set comes from its trade). It does NOT require a non-zero reach
  /// preview: reach is dynamic — the backend's `reconcileReachForWorker` links
  /// workers who join later to an existing open posting — so a zero-reach-today
  /// job is still worth posting.
  ///
  /// #2595 — Post is never held disabled on a missing pick (a dead button never
  /// said why): the missing trade is an inline error at the role ([_validate]);
  /// this getter drives the progress bar.
  bool get _companyCanPost => _tradeForm != null && _pickedSkillIds.isNotEmpty;

  /// A pay/experience box → int, or null when it is empty. The boxes take
  /// digits only (#2595) — the pay ones show Indian grouping ("18,000"), which
  /// [parseWholeNumber] reads straight through.
  static int? _intOrNull(String raw) => parseWholeNumber(raw);

  /// Every reason the form cannot be posted yet, keyed by the control the payer
  /// has to change (#2595) — this form's basics plus the worker-visible content
  /// every posting form insists on ([jobContentErrors]: the card's own fields,
  /// the band ordering and the description screen). Shown inline at the fields
  /// by [_form], and counted by the progress bar.
  Map<JobFormField, String> _validate() {
    final bool agency = _isAgency;
    return <JobFormField, String>{
      // Both are printed on the worker's card (agency) / name the posting's
      // org (company) — never defaulted, so they must be picked or typed.
      if (agency && _tradeKey == null) JobFormField.tradeKey: 'Pick the trade',
      if (!agency && _org.text.trim().isEmpty)
        JobFormField.org: 'Add the company name',
      // #2635 — a company job matches only within the 16 trades, so it is
      // never posted without one — even when the catalogue did not load (its
      // picker then says why and retries).
      if (!agency && _tradeForm == null)
        JobFormField.role: kPostingTradeRequiredMessage,
      // Migration 0141 — the agency role is mandatory when the catalogue
      // drives the form: it selects the trade fields.
      if (agency && _postingTrades.isNotEmpty && _roleKind == null)
        JobFormField.role: 'Pick the role',
      if (_title.text.trim().isEmpty) JobFormField.title: 'Add the job title',
      ...jobContentErrors(
        city: _city.text,
        payMin: _intOrNull(_payMin.text),
        payMax: _intOrNull(_payMax.text),
        payType: _payType,
        expMin: _intOrNull(_expMin.text),
        expMax: _intOrNull(_expMax.text),
        shift: _shift,
        // The only branch-dependent value: the company posting and the agency
        // job keep their own enum state, and only one branch is ever mounted.
        neededBy: agency ? _neededBy : _companyNeededBy,
        description: _description.text,
        requirements: _requirements,
        benefits: _benefits,
      ),
      // No separate "pick a skill" rule for the company: its picked trade
      // always carries its own match skill, and the trade is required above.
    };
  }

  /// The four sections the progress bar counts (#2595), as the controls each
  /// holds — a section is done when none of them has an error. Optional ones
  /// (area, the location note, vacancies, an agency's skills) never count.
  static const List<Set<JobFormField>> _companySections = <Set<JobFormField>>[
    <JobFormField>{
      JobFormField.org,
      JobFormField.title,
      JobFormField.role,
      JobFormField.city,
    },
    <JobFormField>{
      JobFormField.payMin,
      JobFormField.payMax,
      JobFormField.payType,
      JobFormField.expMin,
      JobFormField.expMax,
      JobFormField.shift,
      JobFormField.neededBy,
    },
    <JobFormField>{JobFormField.skills},
    <JobFormField>{
      JobFormField.description,
      JobFormField.benefits,
      JobFormField.requirements,
    },
  ];

  static const List<Set<JobFormField>> _agencySections = <Set<JobFormField>>[
    <JobFormField>{
      JobFormField.tradeKey,
      JobFormField.role,
      JobFormField.title,
      JobFormField.city,
    },
    <JobFormField>{
      JobFormField.payMin,
      JobFormField.payMax,
      JobFormField.payType,
      JobFormField.expMin,
      JobFormField.expMax,
    },
    <JobFormField>{JobFormField.neededBy, JobFormField.shift},
    <JobFormField>{
      JobFormField.description,
      JobFormField.benefits,
      JobFormField.requirements,
    },
  ];

  List<Set<JobFormField>> get _sections =>
      _isAgency ? _agencySections : _companySections;

  /// How many of [_sections] are complete right now.
  int _sectionsDone() {
    // A box the server refused is not done either, until it is changed.
    final Set<JobFormField> open = <JobFormField>{
      ..._validate().keys,
      ..._form.refusals.keys,
    };
    // The company skills section is its trade's form: not done before a trade
    // is picked (#2635).
    if (!_isAgency && !_companyCanPost) open.add(JobFormField.skills);
    return _sections
        .where((Set<JobFormField> section) => section.intersection(open).isEmpty)
        .length;
  }

  /// A keystroke in any box: drop the inline errors it fixed. Nothing NEW is
  /// flagged until the next submit — no nagging mid-typing.
  void _onInputChanged() {
    if (!_form.isEmpty && _form.settle(_validate())) setState(() {});
  }

  List<TextEditingController> get _textBoxes => <TextEditingController>[
        _org,
        _title,
        _location,
        _city,
        _area,
        _payMin,
        _payMax,
        _expMin,
        _expMax,
        _description,
      ];

  /// Everything the payer can enter, flattened so two moments of the form
  /// compare with [listEquals]: boxes trimmed, picks as-is, chip lists in
  /// order, sets and the trade answers order-insensitive.
  List<Object?> _snapshot() => <Object?>[
        for (final TextEditingController box in _textBoxes) box.text.trim(),
        _band,
        _roleKind,
        _tradeKey,
        _neededBy,
        _shift,
        _companyNeededBy,
        _payType,
        _tradeLevel,
        listSnapshotKey(_benefits),
        listSnapshotKey(_requirements),
        setSnapshotKey(_pickedSkillIds),
        setSnapshotKey(_untickedRelatedIds),
        tradeAnswersSnapshotKey(_tradeAnswers),
      ];

  /// True when leaving would throw input away: anything entered since the form
  /// opened, until the post goes through.
  bool get _hasUnsavedChanges =>
      !_posted && !listEquals(_snapshot(), _pristine);

  /// What [field] holds now. A server refusal is pinned to it
  /// ([BbFormErrors.refuse]) and stands until it changes.
  Object? _valueOf(JobFormField field) => switch (field) {
        JobFormField.org => _org.text.trim(),
        JobFormField.tradeKey => _tradeKey,
        JobFormField.role => _roleKind,
        JobFormField.title => _title.text.trim(),
        JobFormField.location => _location.text.trim(),
        JobFormField.city => _city.text.trim(),
        JobFormField.area => _area.text.trim(),
        JobFormField.payMin => _intOrNull(_payMin.text),
        JobFormField.payMax => _intOrNull(_payMax.text),
        JobFormField.payType => _payType,
        JobFormField.expMin => _intOrNull(_expMin.text),
        JobFormField.expMax => _intOrNull(_expMax.text),
        JobFormField.shift => _shift,
        JobFormField.neededBy => _isAgency ? _neededBy : _companyNeededBy,
        JobFormField.skills => setSnapshotKey(_pickedSkillIds),
        JobFormField.description => _description.text.trim(),
        JobFormField.benefits => listSnapshotKey(_benefits),
        JobFormField.requirements => listSnapshotKey(_requirements),
      };

  /// The in-screen back arrow: leaves at once when nothing was entered, and
  /// asks first otherwise (the shell asks the same for the system Back).
  void _leave() => _leavePrompt.guard(
        context,
        dirty: _hasUnsavedChanges,
        leave: widget.onBack,
      );

  /// The company posting's `description`: the payer's OWN words, nothing else.
  ///
  /// #357 once folded every input the create route had no column for into it
  /// (trade, pay, experience, free-text skills). #1646/#1648 gave pay and
  /// experience real columns, and #2635 retired the last two folds: the trade
  /// rides `role_kind` + its trade form, and the free-text "Key skills"
  /// fallback is gone (a company job's skills come from its trade). An
  /// untouched box sends NO description (null), never a filler string.
  String? _companyDescription() {
    final String typed = _description.text.trim();
    return typed.isEmpty ? null : typed;
  }

  Future<void> _submit() async {
    // #2595 — every reason the post cannot go yet is shown AT its field, and
    // the payer is taken to the first one (scroll + shake + error haptic). This
    // used to be six toast branches that NAMED one field at a time.
    final Map<JobFormField, String> errors = _validate();
    if (errors.isNotEmpty) {
      setState(() => _form.show(errors));
      return;
    }
    if (_isAgency) {
      await _submitAgency();
    } else {
      await _submitCompany();
    }
  }

  /// COMPANY create — `POST /payer/job-postings` (+ the old-server repair).
  /// Reached only once [_validate] passes: the basics are there, the bands are
  /// ordered, every card field is set, the description is screened, and one
  /// of the 16 trades is picked (#2635).
  Future<void> _submitCompany() async {
    final String org = _org.text.trim();
    final String title = _title.text.trim();
    final bool v1 = _matchV1 == _MatchV1.available;

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
      //
      // The city comes from the CITY box, never from Location. Location is
      // `location_label` — poster free text the worker feed deliberately never
      // reads — and reusing it here stored "Plot 42, MIDC" as a city, or no
      // city at all when it was left blank.
      final String city = _city.text.trim();
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
      final List<String> matchSkillIds =
          v1 ? _pickedSkillIds.toList(growable: false) : const <String>[];
      final List<String> untickedRelatedIds =
          v1 ? _untickedRelatedIds.toList(growable: false) : const <String>[];

      final JobPosting draft = await locator<PayerApiClient>().createCompanyJob(
        orgLabel: org,
        roleTitle: title,
        locationLabel: location.isEmpty ? null : location,
        description: _companyDescription(),
        vacancyBand: _band,
        // Matching V1 (additive) — the trade's derived set, only sent when the
        // vocabulary is live, so a V1-off server never receives fields it does
        // not understand. The server derives the same set from the trade form.
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
        // #2635 — one of the 16 trades, always ([_validate] refuses without).
        roleKind: _roleKind,
        // Untouched lists send NOTHING (there is nothing stored to clear).
        benefits: benefits.isEmpty ? null : benefits,
        requirements: requirements.isEmpty ? null : requirements,
        // Migration 0141 — the trade-specific form, ALWAYS sent (an untouched
        // one as `{}`): it is what makes the server derive the match skills
        // from the trade's chips rather than read a client list (#2635). The
        // rung is display-only and omitted until picked.
        tradeLevel: _tradeLevel.isEmpty ? null : _tradeLevel,
        tradeAnswers: _tradeAnswers,
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
        roleKind: _roleKind,
        benefits: benefits,
        requirements: requirements,
        matchSkillIds: matchSkillIds,
        untickedRelatedIds: untickedRelatedIds,
        tradeLevel: _tradeLevel.isEmpty ? null : _tradeLevel,
        tradeAnswers: _tradeAnswers,
      );
      if (!mounted) return;
      _posted = true;
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
        icon: landed ? Icons.check_circle_rounded : Icons.info_rounded,
      );
      _leaveAfterPost(draft.id);
    } catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      _showPostFailure(error);
    }
  }

  /// Hand off after a successful post: to [PostJobScreen.onPosted] with the new
  /// posting's id when the host wired it (and the row has one), else [onBack].
  void _leaveAfterPost(String? postingId) {
    final ValueChanged<String>? onPosted = widget.onPosted;
    if (onPosted != null && postingId != null) {
      onPosted(postingId);
    } else {
      widget.onBack();
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
    required String? roleKind,
    required List<String> benefits,
    required List<String> requirements,
    required List<String> matchSkillIds,
    required List<String> untickedRelatedIds,
    required String? tradeLevel,
    required Map<String, List<String>> tradeAnswers,
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
    final bool missingRoleKind = roleKind != null && draft.roleKind == null;
    // A chip list counts as dropped only when we SENT one and the draft came
    // back with nothing stated. `[]` on the draft would mean the server stored
    // an empty list, which a create never does from this form.
    final bool missingBenefits =
        benefits.isNotEmpty && (draft.benefits?.isEmpty ?? true);
    final bool missingRequirements =
        requirements.isNotEmpty && (draft.requirements?.isEmpty ?? true);
    final bool missingSkills =
        matchSkillIds.isNotEmpty && draft.matchSkillIds.isEmpty;
    final bool missingTradeLevel =
        tradeLevel != null && draft.tradeLevel == null;
    final bool missingTradeAnswers =
        tradeAnswers.isNotEmpty && draft.tradeAnswers == null;
    final bool missingAnything = missingCity ||
        missingArea ||
        missingPayMin ||
        missingPayMax ||
        missingPayType ||
        missingExpMin ||
        missingExpMax ||
        missingShift ||
        missingNeededBy ||
        missingRoleKind ||
        missingBenefits ||
        missingRequirements ||
        missingSkills ||
        missingTradeLevel ||
        missingTradeAnswers;
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
        roleKind: missingRoleKind ? roleKind : null,
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
        tradeLevel: missingTradeLevel ? tradeLevel : null,
        tradeAnswers: missingTradeAnswers ? tradeAnswers : null,
      );
      return true;
    } catch (_) {
      // Swallowed ON PURPOSE: the create SUCCEEDED, so this is a partial save,
      // not a failed post. The caller surfaces it as such.
      return false;
    }
  }

  /// A refused post. The server's field errors go AT their boxes — scrolled
  /// to, shaken, with the error haptic — exactly like the form's own (#2595);
  /// a toast says only what no box here holds. The device mirrors only the
  /// phone and email screens, so this is where a company name or a link in
  /// the worker-visible text is caught.
  ///
  /// A refusal naming no field still names the real reason where the server
  /// gave one. A bare 400 on either route means the server rejected the
  /// DETAILS themselves, which "check your connection" would misdescribe: that
  /// text is screened fail-closed on three things — contact details, a
  /// company name, and links — so the message names all three.
  void _showPostFailure(Object error) {
    if (error is PayerApiException) {
      final ({Map<JobFormField, String> placed, List<String> rest}) placement =
          placeServerErrors(error.fieldErrors, isShown: _form.hasAnchor);
      if (placement.placed.isNotEmpty) {
        setState(() => _form.refuse(placement.placed, valueOf: _valueOf));
        if (placement.rest.isNotEmpty) {
          showBbToast(
            context,
            title: 'Could not post',
            message: placement.rest.join(' '),
            icon: Icons.info_rounded,
          );
        }
        return;
      }
    }
    final bool rejected = error is PayerApiException && error.isBadRequest;
    final String? reason =
        error is PayerApiException ? error.validationMessage : null;
    showBbToast(
      context,
      title: 'Could not post',
      message: reason ??
          (rejected
              ? 'The server rejected these details. Take out any phone '
                  'number, email address, company name or link.'
              : 'Something went wrong. Please try again.'),
      icon: Icons.info_rounded,
    );
  }

  /// AGENCY create — the faceless demand contract (`POST /payer/agency/jobs`).
  /// Sends `trade_key`/`title`/`city` (+ optional coarse `area`/pay/experience
  /// bands + `needed_by`). On success → toast + back to My-jobs (which refetches
  /// agency jobs). NEVER an org/employer name (no such field on this route).
  /// Reached only once [_validate] passes.
  Future<void> _submitAgency() async {
    final String title = _title.text.trim();
    final String city = _city.text.trim();
    // [_submit] refused the post while no trade was picked.
    final String tradeKey = _tradeKey!;
    final int? payMin = _intOrNull(_payMin.text);
    final int? payMax = _intOrNull(_payMax.text);
    final int? expMin = _intOrNull(_expMin.text);
    final int? expMax = _intOrNull(_expMax.text);
    final String description = _description.text.trim();

    setState(() => _submitting = true);
    try {
      final String area = _area.text.trim();
      final AgencyJobView created =
          await locator<PayerApiClient>().createAgencyJob(
        tradeKey: tradeKey,
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
        roleKind: _roleKind,
        // The worker-visible half of the card. Untouched inputs send NOTHING
        // (null / omitted), never a filler string or a placeholder chip.
        description: description.isEmpty ? null : description,
        shift: _shift,
        benefits: _benefits.isEmpty ? null : List<String>.of(_benefits),
        requirements:
            _requirements.isEmpty ? null : List<String>.of(_requirements),
        // ADR-0050 — optional demand skills. Sent only once the picker is live
        // and the agent picked something; the route strips it until the API field
        // lands (#1960/#1957), so this is forward-compatible, never a 400.
        matchSkillIds:
            _matchV1 == _MatchV1.available && _pickedSkillIds.isNotEmpty
                ? _pickedSkillIds.toList(growable: false)
                : null,
        tradeLevel: _postingTrades.isNotEmpty && _tradeLevel.isNotEmpty
            ? _tradeLevel
            : null,
        tradeAnswers: _postingTrades.isNotEmpty ? _tradeAnswers : null,
      );
      if (!mounted) return;
      _posted = true;
      showBbToast(
        context,
        title: 'Job posted',
        message: 'Live now — see it under My jobs.',
      );
      _leaveAfterPost(created.id);
    } catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      _showPostFailure(error);
    }
  }

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
    // #2595 — keep the errors on show honest against the CURRENT form: a pick
    // or a chip can fix an error from another control (raising "Pay min" fixes
    // "Max pay must be at least the min"), and those rebuild through setState
    // rather than [_onInputChanged]. Errors only ever drop here.
    if (!_form.isEmpty) _form.settle(_validate());
    return BbLeaveGuard(
      hasUnsavedChanges: () => _hasUnsavedChanges,
      prompt: _leavePrompt,
      watch: _inputs,
      // Transparent so this inner Scaffold never paints over the shell surface
      // — it exists only to pin the primary action below a form that can
      // outgrow the fold (the shared bar the Edit screens use too).
      child: Scaffold(
        backgroundColor: Colors.transparent,
        bottomNavigationBar: BbActionBar(
          child: BbButton(
            label: 'Post job',
            iconLeft: Icons.send_rounded,
            block: true,
            loading: _submitting,
            // Held only while the company form's trade catalogue or match
            // vocabulary is still loading (what the post needs is not known
            // yet). Everything else — including a trade not yet picked, or a
            // catalogue that did not load — is an inline error on tap (#2595),
            // never a dead button that does not say why.
            onPressed: (_isAgency ||
                    (!_postingTradesLoading && _matchV1 != _MatchV1.loading))
                ? _submit
                : null,
          ),
        ),
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            // The header and the progress stay pinned while the form scrolls.
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter,
                AppSpacing.s2,
                AppSpacing.gutter,
                AppSpacing.s3,
              ),
              child: ListBody(
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      BbIconButton(
                        icon: Icons.arrow_back_rounded,
                        semanticLabel: 'Back',
                        onPressed: _leave,
                      ),
                      const SizedBox(width: AppSpacing.s3),
                      Text(
                        'Post a job',
                        style: AppTypography.header(
                          size: AppTypography.sizeLg,
                          weight: FontWeight.w800,
                        ),
                      ),
                      const Spacer(),
                      const BbBadge('Free', tone: BbBadgeTone.success),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.s3),
                  // Typing does not rebuild the form; the bar listens to the
                  // boxes itself (picks rebuild it with the form).
                  ListenableBuilder(
                    listenable: _inputs,
                    builder: (BuildContext context, Widget? _) =>
                        BbStepProgress(
                      done: _sectionsDone(),
                      total: _sections.length,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              // Every field is built (not a lazy list) so the first invalid
              // one can always be scrolled to; a drag closes the keyboard.
              child: SingleChildScrollView(
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.gutter,
                  AppSpacing.s1,
                  AppSpacing.gutter,
                  AppSpacing.s6,
                ),
                // Branch on the locked session role: the agency posts to a
                // DIFFERENT (faceless demand) contract that DOES accept
                // trade/pay/experience.
                child: ListBody(
                  children: _isAgency ? _agencyFields() : _companyFields(),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// A JUL31 section card — paper, 1px hairline, radius 10, elevation 0 — with a
  /// deep-blue normal-face section title. Uses a [ListBody] (never a [Column]) as its
  /// vertical wrapper so the only [Column] ancestor of a field label stays the
  /// field's own — the form tests locate an input by that ancestor.
  Widget _sectionCard(String title, List<Widget> children) => BbCard(
        child: ListBody(
          children: <Widget>[
            Text(
              title,
              style: AppTypography.heading(
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

  /// [control], anchored for its inline error (#2595): when [field] is the
  /// first error on a refused post, this is what scrolls into view and shakes.
  Widget _anchored(JobFormField field, Widget control) =>
      BbShake(key: _form.anchor(field), child: control);

  /// A required enum as kit chips ([BbChipSelect]), anchored with its inline
  /// error. No chip starts selected — submit refuses until the payer taps one,
  /// which is what keeps a default off the worker's card.
  Widget _chipField(
    JobFormField field, {
    required String label,
    required String? value,
    required List<String> options,
    required String Function(String) labelOf,
    required ValueChanged<String> onSelected,
  }) =>
      _anchored(
        field,
        BbChipSelect<String>(
          label: label,
          value: value,
          options: options,
          labelOf: labelOf,
          onSelected: onSelected,
          errorText: _form[field],
        ),
      );

  /// The pay-type selector, shared by both branches (`pay_type`, #1648) — what
  /// the ₹ band the payer just typed actually MEANS to the worker. Offered
  /// straight under the band for that reason.
  Widget _payTypeField() => _chipField(
        JobFormField.payType,
        label: 'Pay type',
        value: _payType,
        options: kJobPayTypes,
        labelOf: _payTypeLabel,
        onSelected: (String v) => setState(() => _payType = v),
      );

  /// The ₹ pay band — two digits-only boxes, ₹-prefixed and grouped (#2595).
  Widget _payBandRow() => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: _anchored(
              JobFormField.payMin,
              JobPayField(
                label: 'Pay min ₹/mo',
                controller: _payMin,
                hint: 'e.g. 18,000',
                errorText: _form[JobFormField.payMin],
                flow: _chain[JobFormField.payMin],
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: _anchored(
              JobFormField.payMax,
              JobPayField(
                label: 'Pay max ₹/mo',
                controller: _payMax,
                hint: 'e.g. 25,000',
                errorText: _form[JobFormField.payMax],
                flow: _chain[JobFormField.payMax],
              ),
            ),
          ),
        ],
      );

  /// The experience window — two digits-only boxes (#2595).
  Widget _experienceRow() => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: _anchored(
              JobFormField.expMin,
              JobExperienceField(
                label: 'Exp min (yrs)',
                controller: _expMin,
                hint: 'e.g. 1',
                errorText: _form[JobFormField.expMin],
                flow: _chain[JobFormField.expMin],
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: _anchored(
              JobFormField.expMax,
              JobExperienceField(
                label: 'Exp max (yrs)',
                controller: _expMax,
                hint: 'e.g. 4',
                errorText: _form[JobFormField.expMax],
                flow: _chain[JobFormField.expMax],
              ),
            ),
          ),
        ],
      );

  /// The job title box (both branches).
  Widget _titleField({String? hint}) => _anchored(
        JobFormField.title,
        BbField(
          label: 'Job title',
          controller: _title,
          hint: hint,
          errorText: _form[JobFormField.title],
          flow: _chain[JobFormField.title],
        ),
      );

  /// THE CARD'S PLACE ROW — the city (required) beside the coarse area bucket
  /// (optional). Both branches.
  Widget _cityAreaRow({String? areaHint}) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: _anchored(
              JobFormField.city,
              BbField(
                label: 'City',
                controller: _city,
                hint: 'e.g. Pune',
                errorText: _form[JobFormField.city],
                flow: _chain[JobFormField.city],
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            // COARSE locality bucket, typed by the payer — deliberately NOT
            // derived from the company form's Location: the server keeps `area`
            // and the free-text `location_label` apart on purpose. Optional,
            // but worker-visible, so the server screens it: anchored for that.
            child: _anchored(
              JobFormField.area,
              BbField(
                label: 'Area (optional)',
                controller: _area,
                hint: areaHint,
                errorText: _form[JobFormField.area],
                flow: _chain[JobFormField.area],
              ),
            ),
          ),
        ],
      );

  /// The worker-visible description, anchored with its inline error (the live
  /// screen of contact details / length shows there as the payer types).
  Widget _descriptionField() => _anchored(
        JobFormField.description,
        JobDescriptionField(
          controller: _description,
          label: 'Description',
          errorText: _form[JobFormField.description],
        ),
      );

  /// The Benefits / Requirements chip rows, anchored with their inline errors.
  List<Widget> _benefitRequirementFields() => <Widget>[
        _anchored(
          JobFormField.benefits,
          _chipListField(
            label: 'Benefits',
            values: _benefits,
            maxItems: JobContentLimits.listItems,
            addLabel: '+ Add benefit',
            onAdd: _addBenefit,
            errorText: _form[JobFormField.benefits],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        _anchored(
          JobFormField.requirements,
          _chipListField(
            label: 'Requirements',
            values: _requirements,
            maxItems: JobContentLimits.listItems,
            addLabel: '+ Add requirement',
            onAdd: _addRequirement,
            errorText: _form[JobFormField.requirements],
          ),
        ),
      ];

  /// `in_hand|gross|ctc` → display labels; null = "Not stated".
  ///
  /// NOT the Needed-by card's "Not set": two different unset states on one form
  /// must read differently. An unpicked pay type sends NOTHING, so the worker's
  /// card shows the band with no pay-type pill — the platform never guesses
  /// net-vs-gross, and "kitna haath me aayega" is the worker's first question.
  static String _payTypeLabel(String? v) => jobPayTypeLabel(v) ?? 'Not stated';

  /// COMPANY posting inputs. #357: every input here reaches
  /// `POST /payer/job-postings` as its own column — org/title/location/vacancy
  /// band, the worker-card content, and the trade (`role_kind` + its trade
  /// form, #2635). Nothing on this form is prefilled and nothing is dropped.
  List<Widget> _companyFields() => <Widget>[
        _sectionCard('Company & role', <Widget>[
          _anchored(
            JobFormField.org,
            BbField(
              label: 'Company / org name',
              controller: _org,
              // Identity name field: keep the keyboard from resurfacing an org
              // name typed in another app (matches signup + account, #1227).
              suppressSuggestions: true,
              errorText: _form[JobFormField.org],
              flow: _chain[JobFormField.org],
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          _titleField(hint: 'e.g. CNC Setter'),
          const SizedBox(height: AppSpacing.s4),
          // Migration 0141 — the ROLE is mandatory and it selects the trade
          // form. #2635 — it is one of the 16 trades, always: there is no free
          // trade or role list to fall back on (a job posted that way could
          // never go live), so the picker says why when it cannot load.
          _anchored(JobFormField.role, _roleField()),
          const SizedBox(height: AppSpacing.s4),
          // THE CARD'S PLACE ROW. Its own input since #1725 — the submit used
          // to reuse the free-text Location below, which is `location_label`
          // and never reaches a worker.
          _cityAreaRow(areaHint: 'e.g. Chakan'),
          const SizedBox(height: AppSpacing.s4),
          // `location_label` — your own wording for the site. Kept optional and
          // said plainly to be internal: the worker feed never reads it, so it
          // can hold the detail the coarse city/area buckets may not. Anchored
          // for the server's length cap.
          _anchored(
            JobFormField.location,
            BbField(
              label: 'Location note (optional, not shown to workers)',
              controller: _location,
              hint: 'e.g. near Chakan MIDC Phase 2',
              errorText: _form[JobFormField.location],
              flow: _chain[JobFormField.location],
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          BbChipSelect<String>(
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
          _payBandRow(),
          const SizedBox(height: AppSpacing.s4),
          _payTypeField(),
          const SizedBox(height: AppSpacing.s4),
          _experienceRow(),
          const SizedBox(height: AppSpacing.s4),
          // Shift + needed-by are worker-visible DISPLAY columns, not match
          // inputs, so they live here and are offered whether or not Matching
          // V1 is on. Null stays "Any shift" / "Not set": an unpicked
          // value sends nothing, so the worker's card never claims a timing the
          // payer did not choose.
          _chipField(
            JobFormField.shift,
            label: 'Shift',
            value: _shift,
            options: const <String>['day', 'night', 'rotational'],
            labelOf: _shiftLabel,
            onSelected: (String v) => setState(() => _shift = v),
          ),
          const SizedBox(height: AppSpacing.s4),
          _chipField(
            JobFormField.neededBy,
            label: 'Needed by',
            value: _companyNeededBy,
            options: const <String>['immediate', 'soon', 'flexible'],
            labelOf: _companyNeededByLabel,
            onSelected: (String v) => setState(() => _companyNeededBy = v),
          ),
        ]),
        const SizedBox(height: AppSpacing.s4),
        // The picked trade's own form (rung + chips) and its reach line — see
        // [_companySkillsSection]. A server refusal of the skills (the cap)
        // lands here, inline (#2595).
        _sectionCard('Skills & matching', <Widget>[
          _anchored(
            JobFormField.skills,
            ListBody(
              children: <Widget>[
                ..._companySkillsSection(),
                BbFieldError(text: _form[JobFormField.skills]),
              ],
            ),
          ),
        ]),
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
          // The card renders a description. The company form used to have no
          // input for one — `description` was COMPOSED from the trade + the
          // V1-off skill chips — so a company posting reached the worker with a
          // "Trade: CNC Setter" line where the work should have been.
          _descriptionField(),
          const SizedBox(height: AppSpacing.s4),
          ..._benefitRequirementFields(),
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
              const Icon(Icons.verified_user_rounded,
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
        // #357 removed a fake 'Boost this posting' toggle; #2589 removed the
        // line that pointed to buying boosts / plans — no payment information
        // of any kind in the app (those live on payer-web only).
      ];

  /// The COMPANY skills area: the picked trade's own form ([_tradeSection]) —
  /// its rung and chips — with the live reach line.
  ///
  /// #2635 — a company job's match skills come from its trade: the server
  /// keeps the trade's own skill plus the chips that trade owns and DROPS any
  /// other id. So the flat vocabulary picker and the free-text "Key skills"
  /// (both of which could name another trade's skills — the 2026-11-03 Welder
  /// job that matched CNC grinding) are no longer offered here. (Shift /
  /// Needed-by are display columns on the Pay & timing card.)
  List<Widget> _companySkillsSection() => <Widget>[_tradeSection()];

  /// The AGENCY demand-skill area (ADR-0050). There is NO free-text fallback: an
  /// agency job's skills only ever ride the closed `match_skill_ids` field, so
  /// when the vocabulary is unavailable the section is simply absent — never a
  /// free-text box whose value could not be sent. Without the trade catalogue
  /// it keeps the flat picker (agency jobs are not scoped by trade, #2635).
  List<Widget> _agencySkillsSection() {
    if (_postingTrades.isNotEmpty) return <Widget>[_tradeSection()];
    switch (_matchV1) {
      case _MatchV1.loading:
        return <Widget>[_skillsLoading()];
      case _MatchV1.unavailable:
        return const <Widget>[];
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
            // Flexible: at a large text scale on a narrow phone the line wraps
            // instead of overflowing the card.
            Flexible(
              child: Text(
                'Loading matching skills…',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
          ],
        ),
      );

  /// One payer-typed chip list, bound to this screen's state (the widget itself
  /// is shared with the edit screens — see [JobChipListField]).
  Widget _chipListField({
    required String label,
    required List<String> values,
    required int maxItems,
    required String addLabel,
    required Future<void> Function() onAdd,
    String? errorText,
  }) =>
      JobChipListField(
        label: label,
        values: values,
        maxItems: maxItems,
        addLabel: addLabel,
        onAdd: onAdd,
        onRemove: (String value) => setState(() => values.remove(value)),
        errorText: errorText,
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

  /// "immediate/soon/flexible" → display labels; null = "Not set".
  static String _companyNeededByLabel(String? v) {
    switch (v) {
      case 'immediate':
        return 'Immediately';
      case 'soon':
        return 'Within weeks';
      case 'flexible':
        return 'Flexible';
      default:
        // An unset timing sends no `needed_by` at all rather than a
        // fabricated "flexible".
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
          _chipField(
            JobFormField.tradeKey,
            label: 'Trade',
            value: _tradeKey,
            options: kAgencyTradeKeys,
            labelOf: agencyTradeLabel,
            onSelected: (String v) => setState(() => _tradeKey = v),
          ),
          const SizedBox(height: AppSpacing.s4),
          // Migration 0141 — the display role selects the trade-specific fields.
          // An older server without the catalogue keeps the legacy trade-only form.
          if (_postingTrades.isNotEmpty) ...<Widget>[
            _anchored(JobFormField.role, _roleField()),
            const SizedBox(height: AppSpacing.s4),
          ],
          _titleField(),
          const SizedBox(height: AppSpacing.s4),
          // The worker card's role illustration (`role_kind`). The trade
          // catalogue's own role picker above already sets it when present.
          if (_postingTrades.isEmpty) ...<Widget>[
            BbSelect<String?>(
              label: 'Role (card illustration)',
              value: _roleKind,
              items: <String?>[null, ...kJobRoleKinds],
              labelOf: (String? v) =>
                  v == null ? 'Not specified' : (jobRoleLabel(v) ?? v),
              onChanged: (String? v) => setState(() => _roleKind = v),
            ),
            const SizedBox(height: AppSpacing.s4),
          ],
          // #357 — was prefilled 'Pune' (and area 'Chakan'); the agency route is
          // just as real, so these start empty too.
          _cityAreaRow(),
        ]),
        // ADR-0050 — the closed demand-skill picker (optional for agency; the
        // twin is served on picked skills). Hidden entirely when the match
        // vocabulary is off, never a free-text fallback.
        if (_matchV1 != _MatchV1.unavailable) ...<Widget>[
          const SizedBox(height: AppSpacing.s4),
          _sectionCard('Skills & matching', _agencySkillsSection()),
        ],
        const SizedBox(height: AppSpacing.s4),
        _sectionCard('Pay, experience & timing', <Widget>[
          _payBandRow(),
          const SizedBox(height: AppSpacing.s4),
          _payTypeField(),
          const SizedBox(height: AppSpacing.s4),
          _experienceRow(),
        ]),
        const SizedBox(height: AppSpacing.s4),
        _sectionCard('Timing', <Widget>[
          _chipField(
            JobFormField.neededBy,
            label: 'Needed by',
            value: _neededBy,
            options: kAgencyNeededBy,
            labelOf: agencyNeededByLabel,
            onSelected: (String v) => setState(() => _neededBy = v),
          ),
          const SizedBox(height: AppSpacing.s4),
          // Null stays "Any shift" — an unpicked shift sends nothing, so the
          // worker's card never claims a shift the payer did not choose.
          _chipField(
            JobFormField.shift,
            label: 'Shift',
            value: _shift,
            options: const <String>['day', 'night', 'rotational'],
            labelOf: _shiftLabel,
            onSelected: (String v) => setState(() => _shift = v),
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
          _descriptionField(),
          const SizedBox(height: AppSpacing.s4),
          ..._benefitRequirementFields(),
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
              const Icon(Icons.info_rounded,
                  size: 22, color: AppColors.bluePressed),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  'Pay, experience, shift and timing are printed on the '
                  "worker's job card — that is why we ask for all of them. "
                  'Posting is free.',
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
