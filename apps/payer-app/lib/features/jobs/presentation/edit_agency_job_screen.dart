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
import 'cubit/agency_jobs_cubit.dart';
import '../domain/worker_card_fields.dart';
import 'widgets/job_content_input.dart';

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
/// worker's card and [workerCardGap] refuses a save that blanks it — so when
/// Area HAD a saved value and is now empty it rides `clear: [area]` and is left
/// OUT of the edit body (a field in both is a 400).
///
/// Pushed as a full page with its own back; on save it drives the SHARED
/// [AgencyJobsCubit] (so the My-jobs list refetches) and pops on success.
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
      TextEditingController(text: widget.job.payMin?.toString() ?? '');
  late final TextEditingController _payMax =
      TextEditingController(text: widget.job.payMax?.toString() ?? '');
  late final TextEditingController _expMin =
      TextEditingController(text: widget.job.minExperienceYears?.toString() ?? '');
  late final TextEditingController _expMax =
      TextEditingController(text: widget.job.maxExperienceYears?.toString() ?? '');

  // NULL when the row states neither — never the FIRST option. A fallback to
  // `kAgencyTradeKeys.first` put 'CNC Operator' on the chip for any row whose
  // trade was unknown, and a save then wrote it to the worker's card as fact.
  late String? _tradeKey =
      kAgencyTradeKeys.contains(widget.job.tradeKey) ? widget.job.tradeKey : null;
  late String? _neededBy =
      kAgencyNeededBy.contains(widget.job.neededBy) ? widget.job.neededBy : null;

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

  @override
  void dispose() {
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

  static int? _intOrNull(String raw) {
    final String t = raw.trim();
    if (t.isEmpty) return null;
    return int.tryParse(t);
  }

  Future<void> _save() async {
    final String title = _title.text.trim();
    final String city = _city.text.trim();
    final String? tradeKey = _tradeKey;
    if (title.isEmpty || tradeKey == null) {
      showBbToast(
        context,
        title: 'Add the basics',
        message: 'Trade and job title are needed — both are printed on the '
            'worker\'s card.',
        icon: Icons.info_outline,
      );
      return;
    }

    final int? payMin = _intOrNull(_payMin.text);
    final int? payMax = _intOrNull(_payMax.text);
    final int? expMin = _intOrNull(_expMin.text);
    final int? expMax = _intOrNull(_expMax.text);
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

    // The card's own fields — the SAME rule the create form applies, because an
    // edit can empty what a create had to fill.
    final WorkerCardGap? gap = workerCardGap(
      city: city,
      payMin: payMin,
      payMax: payMax,
      payType: _payType,
      expMin: expMin,
      expMax: expMax,
      shift: _shift,
      neededBy: _neededBy,
      description: _description.text,
      requirements: _requirements,
      benefits: _benefits,
    );
    if (gap != null) {
      showBbToast(
        context,
        title: gap.title,
        message: gap.message,
        icon: Icons.info_outline,
      );
      return;
    }

    // Worker-visible free text: screened here so one bad line does not 400 the
    // whole save (the chips are screened at entry).
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

    setState(() => _saving = true);
    final String area = _area.text.trim();
    // #1652 — the payer EMPTIED a saved Area: remove it via `clear`. The body
    // carries no `area` then (a field in both lists is a 400), and a box that
    // was never set and is still empty sends neither.
    final bool areaEmptied =
        area.isEmpty && (widget.job.area ?? '').trim().isNotEmpty;
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
      clear: areaEmptied
          ? const <AgencyJobClearField>[AgencyJobClearField.area]
          : null,
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
  /// for enum choices; selected flips to a solid haldi pill. Keeps the same
  /// value/onChanged contract, so the PATCH payload is unchanged.
  /// [value] is nullable so a REQUIRED enum can sit UNPICKED: a row whose trade
  /// or timing the server never stated shows no selected chip, instead of the
  /// first option pretending to be the stored one.
  Widget _chipField<T extends Object>({
    required String label,
    required T? value,
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // Sticky primary action — always visible + hittable regardless of form
      // height (a tall form otherwise pushes it below the fold). One haldi CTA.
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
            label: 'Save changes',
            iconLeft: Icons.check,
            block: true,
            loading: _saving,
            onPressed: _save,
          ),
        ),
      ),
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
              // Job title stays the first TextField in the tree (trade is a chip
              // row, not an input) — the edit test edits it via TextField.first.
              BbField(label: 'Job title', controller: _title),
              const SizedBox(height: AppSpacing.s4),
              _chipField<String>(
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
                    child: BbField(label: 'City', controller: _city),
                  ),
                  const SizedBox(width: AppSpacing.s3),
                  Expanded(
                    child: BbField(label: 'Area (optional)', controller: _area),
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
              // What the band MEANS (#1648). No 'Not stated' chip: the card
              // prints it, so the form never offers to remove one (the PATCH's
              // `clear` could since #1652; the card rule is what forbids it).
              _chipField<String>(
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
            ]),
            const SizedBox(height: AppSpacing.s4),
            // PREFILLED from the row since #1647 — what is on screen IS what the
            // worker's job card is showing right now, so it can be corrected
            // rather than only overwritten.
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
              JobDescriptionField(controller: _description, label: 'Description'),
              const SizedBox(height: AppSpacing.s4),
              _chipField<String>(
                label: 'Shift',
                value: _shift,
                options: _shifts,
                labelOf: _shiftLabel,
                onSelected: (String v) => setState(() => _shift = v),
              ),
              const SizedBox(height: AppSpacing.s4),
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
              ),
              const SizedBox(height: AppSpacing.s4),
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
              ),
            ]),
          ],
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
