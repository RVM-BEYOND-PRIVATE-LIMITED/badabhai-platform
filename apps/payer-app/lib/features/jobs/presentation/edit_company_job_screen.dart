import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/jobs_cubit.dart';
import 'widgets/job_content_input.dart';

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
/// WHAT IT CANNOT DO: the PATCH schema has no way to CLEAR a scalar (every key
/// is an optional value, never a null), so an emptied box is NOT sent and the
/// saved value survives. The two chip LISTS are the exception — `[]` is a legal
/// value there and does clear them — and the copy says exactly that. Only the
/// fields the payer actually CHANGED are sent, so a save can never clobber a
/// value with a stale prefill.
///
/// Pushed as a full page with its own back; drives the SHARED [JobsCubit] (so the
/// My-jobs list refetches) and pops on success.
class EditCompanyJobScreen extends StatefulWidget {
  const EditCompanyJobScreen({
    super.key,
    required this.job,
    required this.cubit,
  });

  final JobPosting job;
  final JobsCubit cubit;

  @override
  State<EditCompanyJobScreen> createState() => _EditCompanyJobScreenState();
}

class _EditCompanyJobScreenState extends State<EditCompanyJobScreen> {
  /// The server's `vacancy_band` enum — exact values the route accepts.
  static const List<String> _bands = <String>['1', '2-5', '6-10', '11-25', '25+'];

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
      TextEditingController(text: widget.job.payMin?.toString() ?? '');
  late final TextEditingController _payMax =
      TextEditingController(text: widget.job.payMax?.toString() ?? '');
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

  /// 'Not set' / 'Not stated' is offered ONLY while nothing is stored: the PATCH
  /// enums have no clear value, so the form never shows a choice it could not
  /// honour.
  late final List<String?> _shiftOptions = <String?>[
    if (_shift == null) null,
    ..._shifts,
  ];
  late final List<String?> _neededByOptions = <String?>[
    if (_neededBy == null) null,
    ..._neededBys,
  ];
  late final List<String?> _payTypeOptions = <String?>[
    if (_payType == null) null,
    ...kJobPayTypes,
  ];

  bool _saving = false;

  @override
  void dispose() {
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

  /// A trimmed whole-number field → int, or null when empty/invalid.
  static int? _intOrNull(String raw) {
    final String t = raw.trim();
    if (t.isEmpty) return null;
    return int.tryParse(t);
  }

  /// [now] when the payer changed it, else null (→ omitted from the PATCH, so
  /// the stored value survives). An EMPTIED box is a null too: this contract
  /// cannot clear a field, and sending a blank would either 400 or lie.
  static String? _changedText(String now, String? before) {
    final String text = now.trim();
    if (text.isEmpty) return null;
    return text == (before ?? '') ? null : text;
  }

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

  Future<void> _save() async {
    final String title = _title.text.trim();
    if (title.isEmpty) {
      showBbToast(
        context,
        title: 'Add the basics',
        message: 'A job title is needed.',
        icon: Icons.info_outline,
      );
      return;
    }

    final int? payMin = _intOrNull(_payMin.text);
    final int? payMax = _intOrNull(_payMax.text);
    final int? expMin = _intOrNull(_expMin.text);
    final int? expMax = _intOrNull(_expMax.text);
    // Same ordering rules the post form and the server both apply.
    if (payMin != null && payMax != null && payMax < payMin) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: 'Max pay must be at least the min.',
        icon: Icons.info_outline,
      );
      return;
    }
    if (expMin != null && expMax != null && expMax < expMin) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: 'Max experience must be at least the min.',
        icon: Icons.info_outline,
      );
      return;
    }

    // The description is worker-visible free text: screened at entry (cap + the
    // server's fail-closed PII rule) so a whole save is never 400'd for it.
    final String? descriptionError = postingDescriptionError(_description.text);
    if (descriptionError != null) {
      showBbToast(
        context,
        title: 'Check the description',
        message: descriptionError,
        icon: Icons.info_outline,
      );
      return;
    }

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
    final String? neededBy = _neededBy == widget.job.neededBy ? null : _neededBy;
    final String? payType = _payType == widget.job.payType ? null : _payType;
    final int? patchPayMin = _changedInt(payMin, widget.job.payMin);
    final int? patchPayMax = _changedInt(payMax, widget.job.payMax);
    final int? patchExpMin =
        _changedInt(expMin, widget.job.minExperienceYears);
    final int? patchExpMax =
        _changedInt(expMax, widget.job.maxExperienceYears);
    final List<String>? benefits =
        _changedList(_benefits, widget.job.benefits);
    final List<String>? requirements =
        _changedList(_requirements, widget.job.requirements);

    final bool nothingChanged = roleTitle == null &&
        location == null &&
        band == null &&
        city == null &&
        area == null &&
        description == null &&
        shift == null &&
        neededBy == null &&
        payType == null &&
        patchPayMin == null &&
        patchPayMax == null &&
        patchExpMin == null &&
        patchExpMax == null &&
        benefits == null &&
        requirements == null;
    if (nothingChanged) {
      // Name the real reason: the server would answer "no effective changes" and
      // the screen would show a misleading "could not update".
      showBbToast(
        context,
        title: 'Nothing to save',
        message: 'Change a field first — nothing on this form is different.',
        icon: Icons.info_outline,
      );
      return;
    }

    setState(() => _saving = true);
    final JobActionResult result = await widget.cubit.editJob(
      widget.job.id!,
      roleTitle: roleTitle,
      // Empty → don't send (keeps the current value) rather than clear it to a
      // blank the route would 400.
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
      description: description,
      // Only when they CHANGED — and an emptied list rides as `[]`, which is
      // how this contract clears the chips.
      benefits: benefits,
      requirements: requirements,
    );
    if (!mounted) return;
    showBbToast(
      context,
      title: result.success ? 'Saved' : 'Not now',
      message: result.message,
      icon: result.success ? Icons.check_circle : Icons.info_outline,
    );
    if (result.success) {
      Navigator.of(context).pop();
    } else {
      setState(() => _saving = false);
    }
  }

  /// A JUL31 section card — paper, 1px hairline, radius 10, elevation 0 — with a
  /// deep-blue Anek section title. Uses a [ListBody] (never a [Column]) as its
  /// vertical wrapper so a field label's only [Column] ancestor stays its own.
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

  /// A labelled single-select rendered as aligned kit chips — the JUL31 pattern
  /// for enum choices; selected flips to a solid haldi pill.
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
    return Scaffold(
      body: SafeArea(
        child: ListView(
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
                  onPressed: () => Navigator.of(context).pop(),
                ),
                const SizedBox(width: AppSpacing.s3),
                Text(
                  'Edit job',
                  style: AppTypography.display(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            _sectionCard('Job details', <Widget>[
              BbField(label: 'Job title', controller: _title),
              const SizedBox(height: AppSpacing.s4),
              BbField(
                label: 'Location',
                controller: _location,
                hint: 'optional',
              ),
              const SizedBox(height: AppSpacing.s4),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Expanded(
                    child: BbField(
                      label: 'City',
                      controller: _city,
                      hint: 'e.g. Pune',
                    ),
                  ),
                  const SizedBox(width: AppSpacing.s3),
                  Expanded(
                    // COARSE locality bucket — never an address, and kept apart
                    // from the free-text Location above on purpose.
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
            _sectionCard('Pay & timing', <Widget>[
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
              // What the band MEANS (#1648). 'Not stated' only while the row
              // states nothing — the PATCH enum cannot clear one.
              _chipField<String?>(
                label: 'Pay type',
                value: _payType,
                options: _payTypeOptions,
                labelOf: _payTypeLabel,
                onSelected: (String? v) => setState(() => _payType = v),
              ),
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
              _chipField<String?>(
                label: 'Shift',
                value: _shift,
                options: _shiftOptions,
                labelOf: _shiftLabel,
                onSelected: (String? v) => setState(() => _shift = v),
              ),
              const SizedBox(height: AppSpacing.s4),
              _chipField<String?>(
                label: 'Needed by',
                value: _neededBy,
                options: _neededByOptions,
                labelOf: _neededByLabel,
                onSelected: (String? v) => setState(() => _neededBy = v),
              ),
            ]),
            const SizedBox(height: AppSpacing.s4),
            _sectionCard('What workers see', <Widget>[
              JobDescriptionField(controller: _description),
              const SizedBox(height: AppSpacing.s4),
              JobChipListField(
                label: 'Benefits',
                values: _benefits,
                maxItems: JobContentLimits.listItems,
                addLabel: '+ Add benefit',
                onAdd: _addBenefit,
                onRemove: (String value) =>
                    setState(() => _benefits.remove(value)),
              ),
              const SizedBox(height: AppSpacing.s4),
              JobChipListField(
                label: 'Requirements',
                values: _requirements,
                maxItems: JobContentLimits.listItems,
                addLabel: '+ Add requirement',
                onAdd: _addRequirement,
                onRemove: (String value) =>
                    setState(() => _requirements.remove(value)),
              ),
            ]),
            const SizedBox(height: AppSpacing.s4),
            Text(
              'Emptying a text box keeps the saved value — this form can change '
              'those details, not remove them. Removing every benefit or '
              'requirement chip DOES clear that list. The trade and any key '
              'skills stay part of the description.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
                height: 1.45,
              ),
            ),
            const SizedBox(height: AppSpacing.s5),
            BbButton(
              label: 'Save changes',
              iconLeft: Icons.check,
              block: true,
              loading: _saving,
              onPressed: _save,
            ),
          ],
        ),
      ),
    );
  }
}
