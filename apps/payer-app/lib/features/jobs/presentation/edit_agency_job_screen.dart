import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/data/payer_api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_haptics.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/number_input.dart';
import '../../../core/widgets/bb_action_bar.dart';
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
import '../../../core/widgets/bb_toast.dart';
import 'cubit/agency_jobs_cubit.dart';
import 'widgets/job_content_input.dart';
import 'widgets/job_form_rules.dart';
import 'widgets/match_skill_picker.dart';
import 'widgets/trade_posting_fields.dart';

/// Edit an existing AGENCY posting (`PATCH /payer/agency/jobs/:id`). The
/// [AgencyJobView] carries every field the route accepts, so the WHOLE form is
/// prefilled and editable — trade / title / city / area / pay & experience bands
/// / pay type / timing, and the worker-visible description, shift and
/// benefit/requirement chips. Mirrors the agency branch of Post-a-job.
///
/// WORKER-VISIBLE CONTENT (description / shift / benefits / requirements) used
/// to be WRITE-ONLY here: the PATCH accepted all four but `toJobView` returned
/// none of them, so the form started empty and had to warn that typing there
/// OVERWRITES what is stored. #1647 made the view return them, so they are
/// prefilled like everything else and that caveat is gone.
///
/// WHAT A SAVE SENDS: only what the payer actually changed. The two chip lists
/// keep a TOUCHED flag — untouched sends nothing (the stored chips survive),
/// while a list the payer emptied on purpose is sent as `[]`.
///
/// EMPTYING A BOX (#1652): the PATCH takes a `clear` list, so a saved value can
/// now be REMOVED. Area is the only OPTIONAL box — every other field is on the
/// worker's card and the shared card rule refuses a save that blanks it — so when
/// Area HAD a saved value and is now empty it rides `clear: [area]` and is left
/// OUT of the edit body (a field in both is a 400).
///
/// Pushed as a full page with its own back; on save it drives the SHARED
/// [AgencyJobsCubit] (so the My-jobs list refetches) and pops on success.
///
/// #2595 (M7) — a refused save shows every reason AT its field and scrolls to
/// the first (shake + error haptic); Save sits in the shared pinned
/// [BbActionBar]; pay/experience boxes are digits-only (pay ₹-prefixed and
/// grouped); the keyboard's "next" walks the text boxes; a drag closes the
/// keyboard; and Back (system or arrow) on an edited form asks before
/// discarding it.
class EditAgencyJobScreen extends StatefulWidget {
  const EditAgencyJobScreen({
    super.key,
    required this.job,
    required this.cubit,
  });

  final AgencyJobView job;
  final AgencyJobsCubit cubit;

  @override
  State<EditAgencyJobScreen> createState() => _EditAgencyJobScreenState();
}

class _EditAgencyJobScreenState extends State<EditAgencyJobScreen> {
  late final TextEditingController _title =
      TextEditingController(text: widget.job.title);
  late final TextEditingController _city =
      TextEditingController(text: widget.job.city);
  late final TextEditingController _area =
      TextEditingController(text: widget.job.area ?? '');
  late final TextEditingController _payMin =
      TextEditingController(text: formatPayInput(widget.job.payMin));
  late final TextEditingController _payMax =
      TextEditingController(text: formatPayInput(widget.job.payMax));
  late final TextEditingController _expMin = TextEditingController(
      text: widget.job.minExperienceYears?.toString() ?? '');
  late final TextEditingController _expMax = TextEditingController(
      text: widget.job.maxExperienceYears?.toString() ?? '');

  // NULL when the row states neither — never the FIRST option. A fallback to
  // `kAgencyTradeKeys.first` put 'CNC Operator' on the chip for any row whose
  // trade was unknown, and a save then wrote it to the worker's card as fact.
  late String? _tradeKey = kAgencyTradeKeys.contains(widget.job.tradeKey)
      ? widget.job.tradeKey
      : null;
  late String? _neededBy = kAgencyNeededBy.contains(widget.job.neededBy)
      ? widget.job.neededBy
      : null;
  late String? _roleKind =
      kJobRoleKinds.contains(widget.job.roleKind) ? widget.job.roleKind : null;

  // --- Worker-visible content, PREFILLED from the row (#1647) ---------------
  // All four come back on the job view now, so there is a real stored value to
  // show — no blank box pretending to be the saved text.
  late final TextEditingController _description =
      TextEditingController(text: widget.job.description ?? '');
  late final List<String> _benefits =
      List<String>.of(widget.job.benefits ?? const <String>[]);
  late final List<String> _requirements =
      List<String>.of(widget.job.requirements ?? const <String>[]);

  /// True once the payer has touched that chip list. It is still the ONLY way
  /// to tell "left alone" (send null → the stored chips stay) from "emptied on
  /// purpose" (send `[]` → CLEAR them server-side): both end in the same empty
  /// list when the row had no chips to begin with.
  bool _benefitsTouched = false;
  bool _requirementsTouched = false;

  /// The stored shift / pay type, or null when the row states neither. Both
  /// are printed on the worker's card, so neither is ever cleared (even though
  /// the PATCH's `clear` could since #1652): a field is sent only when it
  /// CHANGED, and an unpicked one blocks the save until the payer picks.
  late String? _shift =
      _shifts.contains(widget.job.shift) ? widget.job.shift : null;
  late String? _payType =
      kJobPayTypes.contains(widget.job.payType) ? widget.job.payType : null;

  /// The coarse shift enum the PATCH accepts (`day|night|rotational`).
  static const List<String> _shifts = <String>['day', 'night', 'rotational'];

  bool _saving = false;

  // --- ADR-0050 demand skills (optional; #1960) ------------------------------
  // The agency job's `match_skill_ids` pick. Loaded lazily and fail-soft: an
  // unavailable vocabulary (route off / network) simply HIDES the section, never
  // a free-text fallback whose value could not be sent.
  List<MatchSkill> _matchSkills = const <MatchSkill>[];
  bool _matchSkillsLoading = false;
  bool _matchSkillsFailed = false;
  late final Set<String> _pickedSkillIds =
      Set<String>.of(widget.job.matchSkillIds);
  static const int _matchSkillCapFallback = 5;
  final int _maxSkillsPerPosting = _matchSkillCapFallback;

  bool get _matchSkillsAvailable =>
      !_matchSkillsLoading && !_matchSkillsFailed && _matchSkills.isNotEmpty;

  // --- Migration 0141 — the role and its trade-specific form -----------------
  List<PostingTradeForm> _postingTrades = const <PostingTradeForm>[];
  late String _tradeLevel = widget.job.tradeLevel ?? '';
  late Map<String, List<String>> _tradeAnswers =
      widget.job.tradeAnswers ?? const <String, List<String>>{};
  late bool _tradeDirty = false;

  bool get _storedTradeFields =>
      widget.job.tradeLevel != null || widget.job.tradeAnswers != null;

  /// A pre-0141 OPEN job may hold a hand-picked match set; the trade panel is
  /// hidden there so a display-only rung cannot rewrite it. Drafts and jobs
  /// already using the trade form show it, and an explicit role change reveals
  /// it (that is a replacement of the old trade).
  bool get _showTradeForm =>
      _postingTrades.isNotEmpty &&
      (widget.job.status == 'draft' || _storedTradeFields || _tradeDirty);

  PostingTradeForm? _formForKind(String? kind) {
    if (kind == null) return null;
    for (final PostingTradeForm trade in _postingTrades) {
      if (trade.roleKind == kind) return trade;
    }
    return null;
  }

  // --- #2595 (M7) — inline errors, keyboard flow, the leave guard -----------

  /// What is wrong and where; see [_validate].
  final BbFormErrors<JobFormField> _form = BbFormErrors<JobFormField>();

  /// The keyboard's "next" through the text boxes, in the order drawn; "done"
  /// on the last experience box (the chips after it need a tap).
  final BbFocusChain<JobFormField> _chain = BbFocusChain<JobFormField>(
    const <JobFormField>[
      JobFormField.title,
      JobFormField.city,
      JobFormField.area,
      JobFormField.payMin,
      JobFormField.payMax,
      JobFormField.expMin,
      JobFormField.expMax,
    ],
  );

  /// Every text box, merged — typing does not rebuild the form.
  late final Listenable _inputs = Listenable.merge(_textBoxes);

  /// The form as it opened (prefilled from the job).
  late final List<Object?> _pristine;

  /// A trade chip refused at the match-skill cap, explained under the trade
  /// fields; cleared by the next accepted change.
  String? _skillCapError;

  static const BbLeavePrompt _leavePrompt = BbLeavePrompt(
    title: 'Discard your changes?',
    message: 'Your edits to this job have not been saved.',
  );

  @override
  void initState() {
    super.initState();
    _pristine = _snapshot();
    _inputs.addListener(_onInputChanged);
    // ignore: discarded_futures — fire-and-forget; state updates on done.
    _loadMatchSkills();
    // ignore: discarded_futures — the 16-trade form catalogue.
    _loadPostingTrades();
  }

  List<TextEditingController> get _textBoxes => <TextEditingController>[
        _title,
        _city,
        _area,
        _payMin,
        _payMax,
        _expMin,
        _expMax,
        _description,
      ];

  /// Everything on the form, flattened for [listEquals] (see the post form).
  List<Object?> _snapshot() => <Object?>[
        for (final TextEditingController box in _textBoxes) box.text.trim(),
        _tradeKey,
        _neededBy,
        _roleKind,
        _shift,
        _payType,
        _tradeLevel,
        listSnapshotKey(_benefits),
        listSnapshotKey(_requirements),
        setSnapshotKey(_pickedSkillIds),
        tradeAnswersSnapshotKey(_tradeAnswers),
      ];

  /// True when leaving would throw an edit away.
  bool get _hasUnsavedChanges => !listEquals(_snapshot(), _pristine);

  /// Every reason the form cannot be saved, keyed by the control to change —
  /// the trade and title (both printed on the worker's card) plus the
  /// worker-visible content every posting form insists on ([jobContentErrors])
  /// — the SAME rule the create form applies, because an edit can empty what a
  /// create had to fill.
  Map<JobFormField, String> _validate() => <JobFormField, String>{
        if (_tradeKey == null) JobFormField.tradeKey: 'Pick the trade',
        if (_title.text.trim().isEmpty) JobFormField.title: 'Add the job title',
        ...jobContentErrors(
          city: _city.text,
          payMin: _intOrNull(_payMin.text),
          payMax: _intOrNull(_payMax.text),
          payType: _payType,
          expMin: _intOrNull(_expMin.text),
          expMax: _intOrNull(_expMax.text),
          shift: _shift,
          neededBy: _neededBy,
          description: _description.text,
          requirements: _requirements,
          benefits: _benefits,
        ),
      };

  /// A keystroke: drop the inline errors it fixed (nothing new until Save).
  void _onInputChanged() {
    if (!_form.isEmpty && _form.settle(_validate())) setState(() {});
  }

  Future<void> _loadPostingTrades() async {
    try {
      final List<PostingTradeForm> trades =
          await locator<PayerApiClient>().fetchPostingTrades();
      if (!mounted) return;
      setState(() {
        _postingTrades = trades;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _postingTrades = const <PostingTradeForm>[];
      });
    }
  }

  void _selectRole(String kind) {
    final PostingTradeForm? form = _formForKind(kind);
    setState(() {
      _roleKind = kind;
      _skillCapError = null;
      _tradeLevel = '';
      _tradeAnswers = const <String, List<String>>{};
      _tradeDirty = true;
      _pickedSkillIds
        ..clear()
        ..addAll(form?.matchSkillIdsFor(const <String, List<String>>{}) ??
            const <String>[]);
    });
  }

  /// Order-insensitive compare for the trade answer map (question keys and each
  /// selected option list), so a re-tap in another order is not a change.
  static bool _sameTradeAnswers(
    Map<String, List<String>> a,
    Map<String, List<String>>? b,
  ) {
    final Map<String, List<String>> other = b ?? const <String, List<String>>{};
    if (a.length != other.length) return false;
    for (final MapEntry<String, List<String>> entry in a.entries) {
      final List<String>? theirs = other[entry.key];
      if (theirs == null || theirs.length != entry.value.length) return false;
      final Set<String> set = theirs.toSet();
      if (!entry.value.every(set.contains)) return false;
    }
    return true;
  }

  Future<void> _loadMatchSkills() async {
    setState(() => _matchSkillsLoading = true);
    try {
      final List<MatchSkill> skills =
          await locator<PayerApiClient>().fetchMatchSkills();
      if (!mounted) return;
      setState(() {
        _matchSkills = skills;
        _matchSkillsLoading = false;
        _matchSkillsFailed = skills.isEmpty;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _matchSkillsLoading = false;
        _matchSkillsFailed = true;
      });
    }
  }

  void _onToggleSkill(String id) {
    setState(() {
      if (_pickedSkillIds.contains(id)) {
        _pickedSkillIds.remove(id);
      } else if (_pickedSkillIds.length < _maxSkillsPerPosting) {
        _pickedSkillIds.add(id);
      }
    });
  }

  /// Order-insensitive set equality, for "did the pick change?".
  static bool _sameMembers(List<String> a, List<String> b) {
    if (a.length != b.length) return false;
    final Set<String> set = a.toSet();
    return set.length == b.length && b.every(set.contains);
  }

  @override
  void dispose() {
    _inputs.removeListener(_onInputChanged);
    _chain.dispose();
    _title.dispose();
    _city.dispose();
    _area.dispose();
    _payMin.dispose();
    _payMax.dispose();
    _expMin.dispose();
    _expMax.dispose();
    _description.dispose();
    super.dispose();
  }

  /// A pay/experience box → int, or null when empty (the boxes take digits
  /// only; the pay ones show grouping, read straight through).
  static int? _intOrNull(String raw) => parseWholeNumber(raw);

  Future<void> _save() async {
    // #2595 — every reason the save cannot go is shown AT its field, and the
    // payer is taken to the first (scroll + shake + error haptic) — the same
    // rules the post form and the server apply, once toasts naming one field.
    final Map<JobFormField, String> errors = _validate();
    if (errors.isNotEmpty) {
      setState(() => _form.show(errors));
      return;
    }

    final String title = _title.text.trim();
    final String city = _city.text.trim();
    // [_validate] refused the save while no trade was picked.
    final String tradeKey = _tradeKey!;
    final int? payMin = _intOrNull(_payMin.text);
    final int? payMax = _intOrNull(_payMax.text);
    final int? expMin = _intOrNull(_expMin.text);
    final int? expMax = _intOrNull(_expMax.text);
    final String description = _description.text.trim();

    setState(() => _saving = true);
    final String area = _area.text.trim();
    // #1652 — the payer EMPTIED a saved Area: remove it via `clear`. The body
    // carries no `area` then (a field in both lists is a 400), and a box that
    // was never set and is still empty sends neither.
    final bool areaEmptied =
        area.isEmpty && (widget.job.area ?? '').trim().isNotEmpty;
    final bool roleKindEmptied =
        _roleKind == null && widget.job.roleKind != null;
    final String? roleKind =
        roleKindEmptied || _roleKind == widget.job.roleKind ? null : _roleKind;
    // ADR-0050 — send the demand-skill pick only when it CHANGED (an untouched
    // pick omits it, leaving the stored set alone). Stripped by the route until
    // the API field lands (#1960/#1957).
    final List<String> picked = _pickedSkillIds.toList(growable: false);
    final bool skillsChanged = !_sameMembers(picked, widget.job.matchSkillIds);
    // Migration 0141 — the role/rung/answer map is one editorial act. Send it
    // only when it actually moved; the server re-derives `match_skill_ids`.
    final bool tradeChanged = _roleKind != widget.job.roleKind ||
        _tradeLevel != (widget.job.tradeLevel ?? '') ||
        !_sameTradeAnswers(_tradeAnswers, widget.job.tradeAnswers);
    final JobActionResult result = await widget.cubit.editJob(
      widget.job.id,
      tradeKey: tradeKey,
      title: title,
      city: city,
      area: area.isEmpty ? null : area,
      payMin: payMin,
      payMax: payMax,
      // Enums are sent only when CHANGED: re-sending a prefill is noise at
      // best. The card rule above keeps both picked, so null here only ever
      // means "leave the stored value alone".
      payType: _payType == widget.job.payType ? null : _payType,
      minExperienceYears: expMin,
      maxExperienceYears: expMax,
      neededBy: _neededBy,
      roleKind:
          roleKind ?? (tradeChanged && !roleKindEmptied ? _roleKind : null),
      // An EMPTIED description is not sent: `description` is `min(1)` on the
      // contract, so a blank would 400 rather than clear the stored text.
      description: description.isEmpty || description == widget.job.description
          ? null
          : description,
      shift: _shift == widget.job.shift ? null : _shift,
      // Untouched → null → omitted from the PATCH, so the stored chips survive.
      // A touched-but-empty chip list → `[]`, which CLEARS them server-side.
      benefits: _benefitsTouched ? List<String>.of(_benefits) : null,
      requirements:
          _requirementsTouched ? List<String>.of(_requirements) : null,
      tradeLevel: tradeChanged && !roleKindEmptied && _tradeLevel.isNotEmpty
          ? _tradeLevel
          : null,
      tradeAnswers: tradeChanged && !roleKindEmptied ? _tradeAnswers : null,
      matchSkillIds: _matchSkillsAvailable && skillsChanged ? picked : null,
      clear: (areaEmptied || roleKindEmptied)
          ? <AgencyJobClearField>[
              if (areaEmptied) AgencyJobClearField.area,
              if (roleKindEmptied) AgencyJobClearField.roleKind,
              if (roleKindEmptied && widget.job.tradeLevel != null)
                AgencyJobClearField.tradeLevel,
              if (roleKindEmptied && widget.job.tradeAnswers != null)
                AgencyJobClearField.tradeAnswers,
            ]
          : null,
    );
    if (!mounted) return;
    showBbToast(
      context,
      title: result.success ? 'Saved' : 'Not now',
      message: result.message,
      icon: result.success ? Icons.check_circle_rounded : Icons.info_rounded,
    );
    if (result.success) {
      Navigator.of(context).pop();
    } else {
      setState(() => _saving = false);
    }
  }

  /// One worker-visible benefit chip (`benefits[]`, <=80 chars each).
  Future<void> _addBenefit() async {
    final String? phrase = await promptForPostingPhrase(
      context,
      noun: 'benefit',
      maxChars: JobContentLimits.listItemChars,
      title: 'Add a benefit',
      hint: 'e.g. PF + ESI, canteen',
      fieldKey: const Key('add-benefit-field'),
    );
    if (!mounted || phrase == null || _benefits.contains(phrase)) return;
    setState(() {
      _benefits.add(phrase);
      _benefitsTouched = true;
    });
  }

  /// One worker-visible requirement chip (`requirements[]`, <=80 chars each).
  Future<void> _addRequirement() async {
    final String? phrase = await promptForPostingPhrase(
      context,
      noun: 'requirement',
      maxChars: JobContentLimits.listItemChars,
      title: 'Add a requirement',
      hint: 'e.g. Fanuc control, ITI fitter',
      fieldKey: const Key('add-requirement-field'),
    );
    if (!mounted || phrase == null || _requirements.contains(phrase)) return;
    setState(() {
      _requirements.add(phrase);
      _requirementsTouched = true;
    });
  }

  /// A JUL31 section card — paper, 1px hairline, radius 10, elevation 0 — with a
  /// deep-blue normal-face section title. Uses a [ListBody] (never a [Column]) as its
  /// vertical wrapper so a field label's only [Column] ancestor stays its own.
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
  /// first error on a refused save, this is what scrolls into view and shakes.
  Widget _anchored(JobFormField field, Widget control) =>
      BbShake(key: _form.anchor(field), child: control);

  /// An enum as kit chips ([BbChipSelect]); selected flips to a solid haldi
  /// pill. [value] is nullable so a REQUIRED enum can sit UNPICKED: a row whose
  /// trade or timing the server never stated shows no selected chip, instead of
  /// the first option pretending to be the stored one. A validated one
  /// ([field]) is anchored with its inline error.
  Widget _chipField({
    JobFormField? field,
    required String label,
    required String? value,
    required List<String> options,
    required String Function(String) labelOf,
    required ValueChanged<String> onSelected,
  }) {
    final Widget select = BbChipSelect<String>(
      label: label,
      value: value,
      options: options,
      labelOf: labelOf,
      onSelected: onSelected,
      errorText: field == null ? null : _form[field],
    );
    return field == null ? select : _anchored(field, select);
  }

  @override
  Widget build(BuildContext context) {
    // #2595 — a pick can fix an error from another control; errors only drop.
    if (!_form.isEmpty) _form.settle(_validate());
    return BbLeaveGuard(
      hasUnsavedChanges: () => _hasUnsavedChanges,
      prompt: _leavePrompt,
      watch: _inputs,
      child: Scaffold(
        // Sticky primary action — always visible + hittable regardless of form
        // height (a tall form otherwise pushes it below the fold). One haldi
        // CTA, in the bar the post form and the company edit share.
        bottomNavigationBar: BbActionBar(
          child: BbButton(
            label: 'Save changes',
            iconLeft: Icons.check_rounded,
            block: true,
            loading: _saving,
            onPressed: _save,
          ),
        ),
        body: SafeArea(
          // Every field is built (not a lazy list) so the first invalid one
          // can always be scrolled to; a drag closes the keyboard.
          child: SingleChildScrollView(
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s2,
              AppSpacing.gutter,
              AppSpacing.s6,
            ),
            child: ListBody(
              children: <Widget>[
                Row(
                  children: <Widget>[
                    BbIconButton(
                      icon: Icons.arrow_back_rounded,
                      semanticLabel: 'Back',
                      // Through the route's back, so an edited form asks first.
                      onPressed: () => Navigator.of(context).maybePop(),
                    ),
                    const SizedBox(width: AppSpacing.s3),
                    Text(
                      'Edit job',
                      style: AppTypography.header(
                        size: AppTypography.sizeLg,
                        weight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.s4),
                _sectionCard('Job details', <Widget>[
                  // Job title stays the first TextField in the tree (trade is a
                  // chip row, not an input) — the edit test edits it via
                  // TextField.first.
                  _anchored(
                    JobFormField.title,
                    BbField(
                      label: 'Job title',
                      controller: _title,
                      errorText: _form[JobFormField.title],
                      flow: _chain[JobFormField.title],
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  if (_postingTrades.isNotEmpty) ...<Widget>[
                    _chipField(
                      label: 'Role',
                      value: _roleKind,
                      options: _postingTrades
                          .map((PostingTradeForm t) => t.roleKind)
                          .toList(growable: false),
                      labelOf: (String kind) =>
                          _formForKind(kind)?.roleLabel ?? kind,
                      onSelected: _selectRole,
                    ),
                    const SizedBox(height: AppSpacing.s4),
                  ] else ...<Widget>[
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
                  _chipField(
                    field: JobFormField.tradeKey,
                    label: 'Trade',
                    value: _tradeKey,
                    options: kAgencyTradeKeys,
                    labelOf: agencyTradeLabel,
                    onSelected: (String v) => setState(() => _tradeKey = v),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Expanded(
                        child: _anchored(
                          JobFormField.city,
                          BbField(
                            label: 'City',
                            controller: _city,
                            errorText: _form[JobFormField.city],
                            flow: _chain[JobFormField.city],
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.s3),
                      Expanded(
                        child: BbField(
                          label: 'Area (optional)',
                          controller: _area,
                          flow: _chain[JobFormField.area],
                        ),
                      ),
                    ],
                  ),
                ]),
                const SizedBox(height: AppSpacing.s4),
                _sectionCard('Pay & experience', <Widget>[
                  Row(
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
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  // What the band MEANS (#1648). No 'Not stated' chip: the card
                  // prints it, so the form never offers to remove one (the
                  // PATCH's `clear` could since #1652; the card rule is what
                  // forbids it).
                  _chipField(
                    field: JobFormField.payType,
                    label: 'Pay type',
                    value: _payType,
                    options: kJobPayTypes,
                    labelOf: _payTypeLabel,
                    onSelected: (String v) => setState(() => _payType = v),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  Row(
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
                  ),
                ]),
                const SizedBox(height: AppSpacing.s4),
                _sectionCard('Timing', <Widget>[
                  _chipField(
                    field: JobFormField.neededBy,
                    label: 'Needed by',
                    value: _neededBy,
                    options: kAgencyNeededBy,
                    labelOf: agencyNeededByLabel,
                    onSelected: (String v) => setState(() => _neededBy = v),
                  ),
                ]),
                const SizedBox(height: AppSpacing.s4),
                // PREFILLED from the row since #1647 — what is on screen IS what
                // the worker's job card is showing right now, so it can be
                // corrected rather than only overwritten.
                _sectionCard('What workers see', <Widget>[
                  Text(
                    'Shown on the job card exactly as you type it. Leave out '
                    'company names, phone numbers and links.',
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.textMuted,
                      height: 1.45,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s3),
                  _anchored(
                    JobFormField.description,
                    JobDescriptionField(
                      controller: _description,
                      label: 'Description',
                      errorText: _form[JobFormField.description],
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  _chipField(
                    field: JobFormField.shift,
                    label: 'Shift',
                    value: _shift,
                    options: _shifts,
                    labelOf: _shiftLabel,
                    onSelected: (String v) => setState(() => _shift = v),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  _anchored(
                    JobFormField.benefits,
                    JobChipListField(
                      label: 'Benefits',
                      values: _benefits,
                      maxItems: JobContentLimits.listItems,
                      addLabel: '+ Add benefit',
                      onAdd: _addBenefit,
                      onRemove: (String value) => setState(() {
                        _benefits.remove(value);
                        _benefitsTouched = true;
                      }),
                      errorText: _form[JobFormField.benefits],
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  _anchored(
                    JobFormField.requirements,
                    JobChipListField(
                      label: 'Requirements',
                      values: _requirements,
                      maxItems: JobContentLimits.listItems,
                      addLabel: '+ Add requirement',
                      onAdd: _addRequirement,
                      onRemove: (String value) => setState(() {
                        _requirements.remove(value);
                        _requirementsTouched = true;
                      }),
                      errorText: _form[JobFormField.requirements],
                    ),
                  ),
                ]),
                // Migration 0141 — the role's own chips replace the flat picker
                // when the catalogue loaded and this job uses the trade form. An
                // older open job with a hand-picked set keeps the legacy picker.
                if (_showTradeForm) ...<Widget>[
                  const SizedBox(height: AppSpacing.s4),
                  _sectionCard('Trade requirements', <Widget>[
                    if (_formForKind(_roleKind) case final PostingTradeForm form)
                      ...<Widget>[
                        TradePostingFields(
                          trade: form,
                          tradeLevel: _tradeLevel,
                          answers: _tradeAnswers,
                          onChanged: (
                            String level,
                            Map<String, List<String>> answers,
                          ) {
                            final List<String> nextMatch =
                                form.matchSkillIdsFor(answers);
                            if (nextMatch.length > _maxSkillsPerPosting) {
                              // #2595 — said under the chips, not in a toast.
                              // ignore: discarded_futures — fire-and-forget.
                              AppHaptics.error();
                              setState(
                                () => _skillCapError =
                                    matchSkillCapError(_maxSkillsPerPosting),
                              );
                              return;
                            }
                            setState(() {
                              _skillCapError = null;
                              _tradeLevel = level;
                              _tradeAnswers = answers;
                              _tradeDirty = true;
                              _pickedSkillIds
                                ..clear()
                                ..addAll(nextMatch);
                            });
                          },
                        ),
                        BbFieldError(text: _skillCapError),
                      ]
                    else
                      Text(
                        'Pick a role above and the facts that role is hired on '
                        'appear here.',
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.textMuted,
                          height: 1.45,
                        ),
                      ),
                  ]),
                ] else if (_matchSkillsAvailable) ...<Widget>[
                  const SizedBox(height: AppSpacing.s4),
                  _sectionCard('Skills & matching', <Widget>[
                    MatchSkillPicker(
                      skills: _matchSkills,
                      pickedIds: _pickedSkillIds,
                      untickedRelatedIds: const <String>{},
                      reach: null,
                      reachLoading: false,
                      reachFailed: false,
                      onRetryReach: () {},
                      maxSkills: _maxSkillsPerPosting,
                      onToggleSkill: _onToggleSkill,
                      onToggleRelated: (_) {},
                      // Reach is a create-time concern; the edit form stays quiet.
                      showReach: false,
                    ),
                  ]),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// "day/night/rotational" → display labels; null = the honest "Not set". The
  /// shift is on the worker's card, so the form never offers to clear it.
  static String _shiftLabel(String? v) {
    switch (v) {
      case 'day':
        return 'Day';
      case 'night':
        return 'Night';
      case 'rotational':
        return 'Rotational';
      default:
        return 'Not set';
    }
  }

  /// `in_hand|gross|ctc` → display labels; null = "Not stated" (deliberately
  /// worded apart from the shift's "Not set" — two unset states on one form
  /// must read differently). Only offered while nothing is stored.
  static String _payTypeLabel(String? v) => jobPayTypeLabel(v) ?? 'Not stated';
}
