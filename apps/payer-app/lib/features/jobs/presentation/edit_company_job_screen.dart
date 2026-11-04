import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/data/payer_api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/theme/app_colors.dart';
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
import 'cubit/jobs_cubit.dart';
import 'widgets/job_content_input.dart';
import 'widgets/job_form_rules.dart';
import 'widgets/trade_posting_fields.dart';

/// Edit an existing COMPANY posting (`PATCH /payer/job-postings/:id`).
///
/// EVERY field on this form is both READ back on the payer projection and
/// ACCEPTED by the PATCH: role title, location and vacancy band, plus the whole
/// worker-visible half — city, area, the ₹ pay band and what it MEANS
/// (`pay_type`), the experience window, shift, needed-by, the free-text
/// description and the benefit/requirement chips. (It used to carry only the
/// first three and told the payer their pay/experience/skills were "not editable
/// here yet"; the payer row does return them — the app simply did not parse
/// them.)
///
/// EMPTYING A BOX (#1652): the PATCH takes a `clear` list, so a saved value can
/// now be REMOVED, not only overwritten. Only the two OPTIONAL boxes can be
/// emptied at all — Area and the Location note; every other field is on the
/// worker's card and the shared card rule refuses a save that blanks it. So when
/// Area or Location HAD a saved value and is now empty, that field rides
/// `clear` and is left OUT of the edit body (a field in both is a 400). A box
/// that was never set and is still empty sends nothing. Only the fields the
/// payer actually CHANGED are sent, so a save can never clobber a value with a
/// stale prefill.
///
/// Pushed as a full page with its own back; drives the SHARED [JobsCubit] (so the
/// My-jobs list refetches) and pops on success.
///
/// #2595 (M7) — a refused save shows every reason AT its field and scrolls to
/// the first (shake + error haptic); Save sits in the shared pinned
/// [BbActionBar]; pay/experience boxes are digits-only (pay ₹-prefixed and
/// grouped); the keyboard's "next" walks the text boxes; a drag closes the
/// keyboard; and Back (system or arrow) on an edited form asks before
/// discarding it.
///
/// #2635 — a company job matches only within the 16 postable trades, so the
/// role is ALWAYS picked from that catalogue (`GET /payer/posting-trades`):
/// there is no free role list to fall back on. If the catalogue does not load,
/// the picker says why and offers a Retry; the stored role is left untouched.
/// The server's `posting_trade_required` refusal lands AT the picker.
class EditCompanyJobScreen extends StatefulWidget {
  const EditCompanyJobScreen({
    super.key,
    required this.job,
    required this.cubit,
    this.tradeRequired = false,
  });

  final JobPosting job;
  final JobsCubit cubit;

  /// #2635 — opened because the server would not put this job live without
  /// one of the 16 trades (a Publish refused in My jobs). The trade picker
  /// opens with [kPostingTradeRequiredMessage] at it — scrolled to and shaken
  /// once the catalogue has loaded — until a trade is picked.
  final bool tradeRequired;

  @override
  State<EditCompanyJobScreen> createState() => _EditCompanyJobScreenState();
}

class _EditCompanyJobScreenState extends State<EditCompanyJobScreen> {
  /// The server's `vacancy_band` enum — exact values the route accepts.
  static const List<String> _bands = <String>[
    '1',
    '2-5',
    '6-10',
    '11-25',
    '25+'
  ];

  /// The two coarse enums the PATCH accepts (`shift` / `needed_by`).
  static const List<String> _shifts = <String>['day', 'night', 'rotational'];
  static const List<String> _neededBys = <String>[
    'immediate',
    'soon',
    'flexible',
  ];

  late final TextEditingController _title =
      TextEditingController(text: widget.job.title);
  late final TextEditingController _location =
      TextEditingController(text: widget.job.locationLabel ?? '');
  late String _band =
      _bands.contains(widget.job.band) ? widget.job.band : _bands[1];

  // --- The worker-visible display half, PREFILLED from the row --------------
  // Every one of these comes back on `GET /payer/job-postings(/:id)`
  // (`toJobPostingApi`), so there is a real stored value to show — no invented
  // placeholder, and no blank box pretending to be the current text.
  late final TextEditingController _city =
      TextEditingController(text: widget.job.city ?? '');
  late final TextEditingController _area =
      TextEditingController(text: widget.job.area ?? '');
  late final TextEditingController _payMin =
      TextEditingController(text: formatPayInput(widget.job.payMin));
  late final TextEditingController _payMax =
      TextEditingController(text: formatPayInput(widget.job.payMax));
  late final TextEditingController _expMin = TextEditingController(
    text: widget.job.minExperienceYears?.toString() ?? '',
  );
  late final TextEditingController _expMax = TextEditingController(
    text: widget.job.maxExperienceYears?.toString() ?? '',
  );
  late final TextEditingController _description =
      TextEditingController(text: widget.job.description ?? '');

  /// The worker-visible chips. A NULL stored list and an EMPTY one both start
  /// the editor empty; the save compares against the stored value, so an
  /// untouched empty list sends nothing while one the payer emptied is sent as
  /// `[]` and clears the row.
  late final List<String> _benefits =
      List<String>.of(widget.job.benefits ?? const <String>[]);
  late final List<String> _requirements =
      List<String>.of(widget.job.requirements ?? const <String>[]);

  late String? _shift =
      _shifts.contains(widget.job.shift) ? widget.job.shift : null;
  late String? _neededBy =
      _neededBys.contains(widget.job.neededBy) ? widget.job.neededBy : null;
  late String? _payType =
      kJobPayTypes.contains(widget.job.payType) ? widget.job.payType : null;

  /// The stored role, as stored. It changes only when the payer picks one of
  /// the 16 trades (#2635), so an untouched save never sends — or clears — it.
  late String? _roleKind = widget.job.roleKind;

  // NO 'Not set' / 'Not stated' OPTION. Shift, needed-by and pay type are all
  // printed on the worker's card, so "leave it unstated" is not a choice the
  // form can offer — a row that stores none shows NO selected chip and the save
  // is refused until the payer picks one.

  // --- Migration 0141 — the role and its trade-specific form -----------------
  List<PostingTradeForm> _postingTrades = const <PostingTradeForm>[];
  bool _postingTradesLoading = true;

  /// Why the last catalogue load failed (shown at the picker), or null.
  PayerFailure? _postingTradesFailure;

  /// #2635 — [EditCompanyJobScreen.tradeRequired]'s refusal, shown once the
  /// first catalogue load settles (so it lands on the picker, not on the
  /// loading line).
  late bool _tradeRefusalPending = widget.tradeRequired;
  late String _tradeLevel = widget.job.tradeLevel ?? '';
  late Map<String, List<String>> _tradeAnswers =
      widget.job.tradeAnswers ?? const <String, List<String>>{};
  late bool _tradeDirty = false;

  bool get _storedTradeFields =>
      widget.job.tradeLevel != null || widget.job.tradeAnswers != null;

  /// A pre-0141 OPEN posting may hold a hand-picked match set; showing the
  /// trade panel there would let a display-only rung rewrite it. Mirror the web
  /// gate: drafts and trade-form postings show it, and an explicit role change
  /// reveals it (that is a replacement of the old trade).
  bool get _showTradeForm =>
      _postingTrades.isNotEmpty &&
      (widget.job.wireStatus == 'draft' || _storedTradeFields || _tradeDirty);

  PostingTradeForm? _formForKind(String? kind) {
    if (kind == null) return null;
    for (final PostingTradeForm trade in _postingTrades) {
      if (trade.roleKind == kind) return trade;
    }
    return null;
  }

  bool _saving = false;

  // --- #2595 (M7) — inline errors, keyboard flow, the leave guard -----------

  /// What is wrong and where; see [_validate].
  final BbFormErrors<JobFormField> _form = BbFormErrors<JobFormField>();

  /// The keyboard's "next" through the text boxes, in the order drawn; "done"
  /// on the last experience box (the chips after it need a tap).
  final BbFocusChain<JobFormField> _chain = BbFocusChain<JobFormField>(
    const <JobFormField>[
      JobFormField.title,
      JobFormField.location,
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

  /// The form as it opened (prefilled from the row).
  late final List<Object?> _pristine;

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
    _loadPostingTrades();
  }

  List<TextEditingController> get _textBoxes => <TextEditingController>[
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

  /// Everything on the form, flattened for [listEquals] (see the post form).
  List<Object?> _snapshot() => <Object?>[
        for (final TextEditingController box in _textBoxes) box.text.trim(),
        _band,
        _shift,
        _neededBy,
        _payType,
        _roleKind,
        _tradeLevel,
        listSnapshotKey(_benefits),
        listSnapshotKey(_requirements),
        tradeAnswersSnapshotKey(_tradeAnswers),
      ];

  /// True when leaving would throw an edit away.
  bool get _hasUnsavedChanges => !listEquals(_snapshot(), _pristine);

  /// What [field] holds now — a server refusal stands until it changes
  /// ([BbFormErrors.refuse]).
  Object? _valueOf(JobFormField field) => switch (field) {
        // No control on this form, so no refusal is ever placed there.
        JobFormField.org || JobFormField.tradeKey || JobFormField.skills =>
          null,
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
        JobFormField.neededBy => _neededBy,
        JobFormField.description => _description.text.trim(),
        JobFormField.benefits => listSnapshotKey(_benefits),
        JobFormField.requirements => listSnapshotKey(_requirements),
      };

  /// #2595 — a refused save's field errors AT their boxes (scroll, shake and
  /// haptic, like the form's own), and a toast for any reason no box here
  /// holds. False when none had a box: the caller toasts the whole message.
  bool _showRefusal(Map<String, String> fieldErrors) {
    final ({Map<JobFormField, String> placed, List<String> rest}) placement =
        placeServerErrors(fieldErrors, isShown: _form.hasAnchor);
    if (placement.placed.isEmpty) return false;
    setState(() => _form.refuse(placement.placed, valueOf: _valueOf));
    if (placement.rest.isNotEmpty) {
      showBbToast(
        context,
        title: 'Not now',
        message: placement.rest.join(' '),
        icon: Icons.info_rounded,
      );
    }
    return true;
  }

  /// Every reason the form cannot be saved, keyed by the control to change —
  /// the title plus the worker-visible content every posting form insists on
  /// ([jobContentErrors]). Checked against the FORM state, which is the
  /// resulting card: every box here is prefilled from the stored row, so a
  /// blank one is either a field the row never had or one the payer just
  /// emptied, and both leave the same hole on the worker's card.
  Map<JobFormField, String> _validate() => <JobFormField, String>{
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

  /// Load — or, from Retry, reload — the 16-trade catalogue. A failure keeps
  /// the stored role untouched and names the cause at the picker (#2635).
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
      if (_tradeRefusalPending) {
        _tradeRefusalPending = false;
        // Pinned to the role the job holds now: it stands until a trade is
        // picked, however much else the payer edits.
        _form.refuse(
          const <JobFormField, String>{
            JobFormField.role: kPostingTradeRequiredMessage,
          },
          valueOf: _valueOf,
        );
      }
    });
  }

  void _selectRole(String kind) {
    setState(() {
      _roleKind = kind;
      _tradeLevel = '';
      _tradeAnswers = const <String, List<String>>{};
      _tradeDirty = true;
    });
  }

  @override
  void dispose() {
    _inputs.removeListener(_onInputChanged);
    _chain.dispose();
    _title.dispose();
    _location.dispose();
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

  /// [now] when the payer changed it, else null (→ omitted from the PATCH, so
  /// the stored value survives). An EMPTIED box is a null too — a blank is
  /// never a value (it would 400); removing the saved one is [_emptied]'s job,
  /// through `clear`, so the two can never put one field in both lists.
  static String? _changedText(String now, String? before) {
    final String text = now.trim();
    if (text.isEmpty) return null;
    return text == (before ?? '') ? null : text;
  }

  /// True when the payer EMPTIED a box that had a saved value (#1652) — the
  /// field then rides `clear`. A box that was never set and is still empty is
  /// not a change, and sends nothing.
  static bool _emptied(String now, String? before) =>
      now.trim().isEmpty && (before ?? '').trim().isNotEmpty;

  /// [now] when the payer changed the number, else null (same reasoning).
  static int? _changedInt(int? now, int? before) =>
      now == null || now == before ? null : now;

  /// [now] when the payer changed the chip list, else null. UNLIKE the scalars,
  /// an EMPTY list IS a legal patch value here (`[]` clears the chips), so the
  /// only thing that decides is whether the list DIFFERS from the stored one —
  /// a null stored value and an untouched empty editor are the same thing and
  /// send nothing.
  static List<String>? _changedList(List<String> now, List<String>? before) {
    final List<String> stored = before ?? const <String>[];
    if (now.length == stored.length) {
      bool same = true;
      for (int i = 0; i < now.length; i++) {
        if (now[i] != stored[i]) {
          same = false;
          break;
        }
      }
      if (same) return null;
    }
    return List<String>.of(now);
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
    final int? payMin = _intOrNull(_payMin.text);
    final int? payMax = _intOrNull(_payMax.text);
    final int? expMin = _intOrNull(_expMin.text);
    final int? expMax = _intOrNull(_expMax.text);

    // Only what actually CHANGED rides the PATCH — a resent prefill would be
    // pointless at best and, on a stale row, a clobber.
    final String? city = _changedText(_city.text, widget.job.city);
    final String? area = _changedText(_area.text, widget.job.area);
    final String? description =
        _changedText(_description.text, widget.job.description);
    final String? location =
        _changedText(_location.text, widget.job.locationLabel);
    final String? roleTitle = title == widget.job.title ? null : title;
    final String? band = _band == widget.job.band ? null : _band;
    final String? shift = _shift == widget.job.shift ? null : _shift;
    final String? neededBy =
        _neededBy == widget.job.neededBy ? null : _neededBy;
    final String? payType = _payType == widget.job.payType ? null : _payType;
    // #2635 — only ever one of the 16 trades: the picker offers nothing else
    // and nothing here unsets it (a live job cannot leave the 16).
    final String? roleKind = _roleKind == widget.job.roleKind ? null : _roleKind;
    final int? patchPayMin = _changedInt(payMin, widget.job.payMin);
    final int? patchPayMax = _changedInt(payMax, widget.job.payMax);
    final int? patchExpMin = _changedInt(expMin, widget.job.minExperienceYears);
    final int? patchExpMax = _changedInt(expMax, widget.job.maxExperienceYears);
    final List<String>? benefits = _changedList(_benefits, widget.job.benefits);
    final List<String>? requirements =
        _changedList(_requirements, widget.job.requirements);
    // Migration 0141 — the role/rung/answer map is one editorial act. Send it
    // only when it actually moved; an untouched edit leaves the stored form
    // (and the match set derived from it) alone.
    final bool tradeChanged = _roleKind != widget.job.roleKind ||
        _tradeLevel != (widget.job.tradeLevel ?? '') ||
        !_sameTradeAnswers(_tradeAnswers, widget.job.tradeAnswers);
    // #1652 — the OPTIONAL boxes the payer emptied: removed via `clear`. Every
    // other field is required above, so it can never reach here empty. Each is
    // null in the body ([_changedText] of an empty box), never in both lists.
    final List<JobPostingClearField> clear = <JobPostingClearField>[
      if (_emptied(_area.text, widget.job.area)) JobPostingClearField.area,
      if (_emptied(_location.text, widget.job.locationLabel))
        JobPostingClearField.locationLabel,
    ];

    final bool nothingChanged = roleTitle == null &&
        location == null &&
        band == null &&
        city == null &&
        area == null &&
        description == null &&
        shift == null &&
        neededBy == null &&
        payType == null &&
        roleKind == null &&
        patchPayMin == null &&
        patchPayMax == null &&
        patchExpMin == null &&
        patchExpMax == null &&
        benefits == null &&
        requirements == null &&
        !tradeChanged &&
        clear.isEmpty;
    if (nothingChanged) {
      // Name the real reason: the server would answer "no effective changes" and
      // the screen would show a misleading "could not update".
      showBbToast(
        context,
        title: 'Nothing to save',
        message: 'Change a field first — nothing on this form is different.',
        icon: Icons.info_rounded,
      );
      return;
    }

    setState(() => _saving = true);
    final JobActionResult result = await widget.cubit.editJob(
      widget.job.id!,
      roleTitle: roleTitle,
      // Empty → never sent as a blank the route would 400; an emptied saved
      // value is removed through [clear] below instead.
      locationLabel: location,
      vacancyBand: band,
      city: city,
      area: area,
      payMin: patchPayMin,
      payMax: patchPayMax,
      payType: payType,
      minExperienceYears: patchExpMin,
      maxExperienceYears: patchExpMax,
      shift: shift,
      neededBy: neededBy,
      roleKind: roleKind ?? (tradeChanged ? _roleKind : null),
      description: description,
      // Only when they CHANGED — and an emptied list rides as `[]`, which is
      // how this contract clears the chips.
      benefits: benefits,
      requirements: requirements,
      tradeLevel:
          tradeChanged && _tradeLevel.isNotEmpty ? _tradeLevel : null,
      tradeAnswers: tradeChanged ? _tradeAnswers : null,
      clear: clear.isEmpty ? null : clear,
    );
    if (!mounted) return;
    if (!result.success && _showRefusal(result.fieldErrors)) {
      setState(() => _saving = false);
      return;
    }
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
  /// pill. [value] is nullable so a REQUIRED enum can sit UNPICKED on a row
  /// that stores none — no chip is selected until the payer taps one. A
  /// validated one ([field]) is anchored with its inline error.
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

  /// The trade picker — the 16 trades of the catalogue as chips — with its
  /// inline error. While the catalogue loads, or if it did not, the same spot
  /// says so (with a Retry), so an error placed at the role always has a
  /// control to show under (#2635).
  Widget _roleField() {
    if (!_postingTradesLoading && _postingTrades.isNotEmpty) {
      return BbChipSelect<String>(
        label: 'Role',
        value: _roleKind,
        options: _postingTrades
            .map((PostingTradeForm t) => t.roleKind)
            .toList(growable: false),
        labelOf: (String kind) => _formForKind(kind)?.roleLabel ?? kind,
        onSelected: _selectRole,
        errorText: _form[JobFormField.role],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          'Role',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        if (_postingTradesLoading)
          Text(
            kPostingTradesLoadingLabel,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          )
        else
          PostingTradesUnavailable(
            failure: _postingTradesFailure,
            onRetry: _loadPostingTrades,
          ),
        BbFieldError(text: _form[JobFormField.role]),
      ],
    );
  }

  /// "day/night/rotational" → display labels; null = the honest "Not set" (only
  /// offered while nothing is stored — see [_shiftOptions]).
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
  /// worded apart from the two "Not set" enums above — different unset states on
  /// one form must read differently). Only offered while nothing is stored.
  static String _payTypeLabel(String? v) => jobPayTypeLabel(v) ?? 'Not stated';

  /// One worker-visible benefit chip (`benefits[]`, <=80 chars each). The cap
  /// and the PII screen live in [promptForPostingPhrase] — one copy for every
  /// surface that enters a chip.
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
    setState(() => _benefits.add(phrase));
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
    setState(() => _requirements.add(phrase));
  }

  /// "immediate/soon/flexible" → display labels; null = "Not set".
  static String _neededByLabel(String? v) {
    switch (v) {
      case 'immediate':
        return 'Immediately';
      case 'soon':
        return 'Within weeks';
      case 'flexible':
        return 'Flexible';
      default:
        return 'Not set';
    }
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
        // #2595 — Save is pinned like Post's (the shared bar): it used to sit
        // at the very end of this tall form, below the fold.
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
                  // #2635 — the role is one of the 16 trades, always; the
                  // server's refusal of a role it cannot match lands here.
                  _anchored(JobFormField.role, _roleField()),
                  const SizedBox(height: AppSpacing.s4),
                  _anchored(
                    JobFormField.location,
                    BbField(
                      label: 'Location',
                      controller: _location,
                      hint: 'optional',
                      errorText: _form[JobFormField.location],
                      flow: _chain[JobFormField.location],
                    ),
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
                            hint: 'e.g. Pune',
                            errorText: _form[JobFormField.city],
                            flow: _chain[JobFormField.city],
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.s3),
                      Expanded(
                        // COARSE locality bucket — never an address, and kept
                        // apart from the free-text Location above on purpose.
                        // Worker-visible, so the server screens it.
                        child: _anchored(
                          JobFormField.area,
                          BbField(
                            label: 'Area (optional)',
                            controller: _area,
                            hint: 'e.g. Chakan',
                            errorText: _form[JobFormField.area],
                            flow: _chain[JobFormField.area],
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.s4),
                  _chipField(
                    label: 'Vacancies',
                    value: _band,
                    options: _bands,
                    labelOf: (String b) => b,
                    onSelected: (String v) => setState(() => _band = v),
                  ),
                ]),
                if (_showTradeForm) ...<Widget>[
                  const SizedBox(height: AppSpacing.s4),
                  _sectionCard('Trade requirements', <Widget>[
                    if (_formForKind(_roleKind) case final PostingTradeForm form)
                      TradePostingFields(
                        trade: form,
                        tradeLevel: _tradeLevel,
                        answers: _tradeAnswers,
                        onChanged: (
                          String level,
                          Map<String, List<String>> answers,
                        ) {
                          setState(() {
                            _tradeLevel = level;
                            _tradeAnswers = answers;
                            _tradeDirty = true;
                          });
                        },
                      )
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
                ],
                const SizedBox(height: AppSpacing.s4),
                _sectionCard('Pay & timing', <Widget>[
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
                  _chipField(
                    field: JobFormField.neededBy,
                    label: 'Needed by',
                    value: _neededBy,
                    options: _neededBys,
                    labelOf: _neededByLabel,
                    onSelected: (String v) => setState(() => _neededBy = v),
                  ),
                ]),
                const SizedBox(height: AppSpacing.s4),
                _sectionCard('What workers see', <Widget>[
                  _anchored(
                    JobFormField.description,
                    JobDescriptionField(
                      controller: _description,
                      label: 'Description',
                      errorText: _form[JobFormField.description],
                    ),
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
                      onRemove: (String value) =>
                          setState(() => _benefits.remove(value)),
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
                      onRemove: (String value) =>
                          setState(() => _requirements.remove(value)),
                      errorText: _form[JobFormField.requirements],
                    ),
                  ),
                ]),
                const SizedBox(height: AppSpacing.s4),
                Text(
                  'Emptying Area or Location removes it from the job. The other '
                  'details can be changed but not left blank. The role and its '
                  'trade requirements stay on the worker’s job detail.',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.textMuted,
                    height: 1.45,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
