import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart' show QualificationOptionsDto;
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../domain/trade_form_models.dart';
import 'trade_form_text_field.dart';

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kCertTitle = 'Koi certificate ya licence hai?';
const String _kCertSubtitle = 'Zyada se zyada 8 certificate likh sakte hain.';
const String _kAddCertificate = 'Aur ek certificate jodein';
const String _kCertNameLabel = 'Certificate ka naam';
const String _kCertNameHint = 'Jaise: CNC Turning & Fanuc Programming';
const String _kIssuerLabel = 'Kisne diya';
const String _kIssuerHint = 'Jaise: Govt. ITI, Faridabad';
const String _kCertYearLabel = 'Kis saal mila';
const String _kCertYearHint = 'Jaise: 2020';

const String _kEduTitle = 'Padhai ya ITI ki jaankari';
const String _kEduSubtitle = 'Zyada se zyada 4 entry likh sakte hain.';
const String _kAddEducation = 'Aur ek entry jodein';
const String _kCredentialLabel = 'ITI ya Diploma?';
const String _kFieldLabel = 'Trade ya subject';
const String _kFieldHint = 'Jaise: Machinist';
const String _kCouncilLabel = 'Council / board';
const String _kEduYearLabel = 'Kis saal poora hua';
const String _kEduYearHint = 'Jaise: 2018';
const String _kInstituteLabel = 'Institute ka naam';
const String _kInstituteHint = 'Jaise: Govt. ITI, Faridabad';
const String _kRemove = 'Hataayein';
const String _kOptionsLoadError = 'Kuch gadbad ho gayi. Dobara koshish karein.';
const String _kRetry = 'Dobara koshish karein';

const int _kYearMin = 1950;
const String _kYearFutureError = 'Yeh saal abhi aaya nahi — sahi saal likhein';
const String _kYearInvalidError = 'Sahi saal likhein';

/// The tap-to-fill suggestion row shows at most this many chips at once — a
/// low-literacy worker scanning a phone screen, not a full picklist.
const int _kMaxSuggestionChips = 6;

/// The `type: "qualifications"` marker screen (#1384/#1385, migration 0098)
/// — the certificates + education rows `PUT /workers/me/qualifications`
/// owns. Two independent repeatable sections, mirroring
/// `TradeFormEmploymentPage`'s add/remove-row pattern.
///
/// #1384 item 2 — the two sections are now separate INTERNAL pages (page 0:
/// certificates, page 1: education) rather than stacked on one scroll — the
/// natural two-subsection split this widget already had.
///
/// TRI-STATE, NOT "always send both lists" (see `trade_form_models.dart`'s
/// `TradeFormQualifications` doc): this widget's only job is to track,
/// per section, whether the worker touched it at all — [save] hands the
/// cubit a [TradeFormQualifications] with `certificatesTouched`/
/// `educationsTouched` set the moment a row is added, edited, or removed,
/// and left false if the worker never interacts with that half of the page.
class TradeFormQualificationsPage extends StatefulWidget {
  const TradeFormQualificationsPage({
    super.key,
    required this.suggestedCertificates,
    required this.loadOptions,
    required this.enabled,
    required this.onSave,
    this.initialQualifications,
    this.onPageChanged,
  });

  /// Per-trade certificate-name suggestions from the form schema
  /// (`TradeFormQualificationsStep.suggestedCertificates`) — autocomplete
  /// only, never a closed set the worker is limited to.
  final List<String> suggestedCertificates;

  final Future<QualificationOptionsDto> Function() loadOptions;
  final bool enabled;
  final ValueChanged<TradeFormQualifications> onSave;

  /// The cubit's own memory of the last successful save for THIS marker
  /// (#1384 item 1, `TradeFormState.savedQualifications`) — see the doc on
  /// `TradeFormPreferencesPage.initialPreferences` for why a `GlobalKey`
  /// alone cannot carry this across a `goBack()`.
  final TradeFormQualifications? initialQualifications;

  /// #1384 item 2 — see `TradeFormPreferencesPage.onPageChanged`'s doc; the
  /// same contract, off a fixed [pageCount] of 2 (certificates, education).
  final void Function(int page, int pageCount)? onPageChanged;

  @override
  State<TradeFormQualificationsPage> createState() =>
      TradeFormQualificationsPageState();
}

class TradeFormQualificationsPageState
    extends State<TradeFormQualificationsPage> {
  /// Page 0: certificates · 1: education. Fixed — this marker's two
  /// sub-sections never change count at runtime.
  static const int pageCount = 2;

  QualificationOptionsDto? _options;
  String? _optionsLoadError;

  late List<TradeFormCertificateEntry> _certificates =
      List<TradeFormCertificateEntry>.of(
          widget.initialQualifications?.certificates ??
              const <TradeFormCertificateEntry>[]);
  late bool _certificatesTouched =
      widget.initialQualifications?.certificatesTouched ?? false;

  late List<TradeFormEducationEntry> _educations = List<TradeFormEducationEntry>.of(
      widget.initialQualifications?.educations ??
          const <TradeFormEducationEntry>[]);
  late bool _educationsTouched =
      widget.initialQualifications?.educationsTouched ?? false;

  int _page = 0;
  bool get isFirstPage => _page <= 0;
  bool get isLastPage => _page >= pageCount - 1;

  @override
  void initState() {
    super.initState();
    _loadOptions();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.onPageChanged?.call(_page, pageCount);
    });
  }

  void goToNextPage() {
    if (isLastPage) return;
    setState(() => _page += 1);
    widget.onPageChanged?.call(_page, pageCount);
  }

  void goToPreviousPage() {
    if (isFirstPage) return;
    setState(() => _page -= 1);
    widget.onPageChanged?.call(_page, pageCount);
  }

  Future<void> _loadOptions() async {
    try {
      final QualificationOptionsDto options = await widget.loadOptions();
      if (!mounted) return;
      setState(() {
        _options = options;
        _optionsLoadError = null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _optionsLoadError = _kOptionsLoadError);
    }
  }

  /// Called by the screen's sticky bottom bar ONLY on this marker's LAST
  /// internal page — see `_WizardScaffoldState`'s routing.
  void save() => widget.onSave(TradeFormQualifications(
        certificates: _certificates,
        certificatesTouched: _certificatesTouched,
        educations: _educations,
        educationsTouched: _educationsTouched,
      ));

  // --- Certificates ----------------------------------------------------

  void _addCertificate() {
    if (_certificates.length >= kTradeFormMaxCertificates) return;
    setState(() {
      _certificates = <TradeFormCertificateEntry>[
        ..._certificates,
        const TradeFormCertificateEntry(name: ''),
      ];
      _certificatesTouched = true;
    });
  }

  void _updateCertificate(int index, TradeFormCertificateEntry entry) {
    final List<TradeFormCertificateEntry> next =
        List<TradeFormCertificateEntry>.of(_certificates);
    next[index] = entry;
    setState(() {
      _certificates = next;
      _certificatesTouched = true;
    });
  }

  void _removeCertificate(int index) {
    final List<TradeFormCertificateEntry> next =
        List<TradeFormCertificateEntry>.of(_certificates)..removeAt(index);
    setState(() {
      _certificates = next;
      _certificatesTouched = true;
    });
  }

  // --- Education ---------------------------------------------------------

  void _addEducation() {
    if (_educations.length >= kTradeFormMaxEducations) return;
    setState(() {
      _educations = <TradeFormEducationEntry>[
        ..._educations,
        const TradeFormEducationEntry(),
      ];
      _educationsTouched = true;
    });
  }

  void _updateEducation(int index, TradeFormEducationEntry entry) {
    final List<TradeFormEducationEntry> next =
        List<TradeFormEducationEntry>.of(_educations);
    next[index] = entry;
    setState(() {
      _educations = next;
      _educationsTouched = true;
    });
  }

  void _removeEducation(int index) {
    final List<TradeFormEducationEntry> next =
        List<TradeFormEducationEntry>.of(_educations)..removeAt(index);
    setState(() {
      _educations = next;
      _educationsTouched = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: _page == 0 ? _certificatesPage() : _educationPage(),
      ),
    );
  }

  Widget _certificatesPage() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(_kCertTitle, style: AppTypography.display(size: AppTypography.sizeLg)),
        const SizedBox(height: AppSpacing.s2),
        Text(_kCertSubtitle,
            style: AppTypography.body(
                size: AppTypography.sizeSm, color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s4),
        for (int i = 0; i < _certificates.length; i++) ...<Widget>[
          _CertificateCard(
            key: ValueKey<int>(i),
            entry: _certificates[i],
            suggestions: widget.suggestedCertificates,
            onChanged: (TradeFormCertificateEntry e) =>
                _updateCertificate(i, e),
            onRemove: () => _removeCertificate(i),
          ),
          const SizedBox(height: AppSpacing.s3),
        ],
        if (_certificates.length < kTradeFormMaxCertificates)
          BbButton(
            label: _kAddCertificate,
            variant: BbButtonVariant.outline,
            size: BbButtonSize.md,
            iconLeft: Icons.add,
            block: true,
            onPressed: _addCertificate,
          ),
      ],
    );
  }

  Widget _educationPage() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(_kEduTitle, style: AppTypography.display(size: AppTypography.sizeLg)),
        const SizedBox(height: AppSpacing.s2),
        Text(_kEduSubtitle,
            style: AppTypography.body(
                size: AppTypography.sizeSm, color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s4),
        _educationSection(),
      ],
    );
  }

  Widget _educationSection() {
    if (_optionsLoadError != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(_optionsLoadError!, style: AppTypography.body(size: AppTypography.sizeBase)),
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: _kRetry,
            variant: BbButtonVariant.secondary,
            size: BbButtonSize.md,
            onPressed: _loadOptions,
          ),
        ],
      );
    }
    final QualificationOptionsDto? options = _options;
    if (options == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(AppSpacing.s6),
          child: CircularProgressIndicator(color: AppColors.blue),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int i = 0; i < _educations.length; i++) ...<Widget>[
          _EducationCard(
            key: ValueKey<int>(i),
            entry: _educations[i],
            credentialOptions: options.educationCredential,
            councilOptions: options.educationCouncil,
            onChanged: (TradeFormEducationEntry e) => _updateEducation(i, e),
            onRemove: () => _removeEducation(i),
          ),
          const SizedBox(height: AppSpacing.s3),
        ],
        if (_educations.length < kTradeFormMaxEducations)
          BbButton(
            label: _kAddEducation,
            variant: BbButtonVariant.outline,
            size: BbButtonSize.md,
            iconLeft: Icons.add,
            block: true,
            onPressed: _addEducation,
          ),
      ],
    );
  }
}

/// Floor `1950` (`wc_year_chk` / `wed_year_chk`'s living-memory bound), ceiling
/// TODAY'S year, not the server's fixed `2100` — a certificate or an ITI
/// cannot be dated in the future, so the client shouldn't produce a value the
/// server would only accept because its own bound is far looser. Null when
/// unparsable or out of range — a client that only ever produces an in-range
/// value cannot send one out of range.
int? _yearInRange(String s) {
  final int? v = int.tryParse(s.trim());
  if (v == null || v < _kYearMin || v > DateTime.now().year) return null;
  return v;
}

/// Inline message for the year field, or null while still valid (including
/// mid-typing a 4-digit year — nothing under 4 digits is flagged yet).
String? _yearErrorText(String s) {
  final String t = s.trim();
  if (t.length < 4) return null;
  if (t.length > 4) return _kYearInvalidError;
  final int? v = int.tryParse(t);
  if (v == null) return _kYearInvalidError;
  if (v > DateTime.now().year) return _kYearFutureError;
  if (v < _kYearMin) return _kYearInvalidError;
  return null;
}

String? _trimOrNull(String v) {
  final String t = v.trim();
  return t.isEmpty ? null : t;
}

Widget _fieldLabel(String text) => Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s1),
      child: Text(text,
          style: AppTypography.body(
              size: AppTypography.sizeSm, weight: FontWeight.w700)),
    );

Widget _cardShell({required Widget child, required VoidCallback onRemove}) {
  return Container(
    padding: const EdgeInsets.all(AppSpacing.s4),
    decoration: BoxDecoration(
      color: AppColors.surfaceCard,
      borderRadius: BorderRadius.circular(AppRadii.sm),
      border: Border.all(color: AppColors.borderSubtle),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Align(
          alignment: Alignment.centerRight,
          child: IconButton(
            onPressed: onRemove,
            icon: const Icon(Icons.close, size: 20, color: AppColors.textMuted),
            tooltip: _kRemove,
            constraints:
                const BoxConstraints(minWidth: AppSpacing.tap, minHeight: 32),
            padding: EdgeInsets.zero,
          ),
        ),
        child,
      ],
    ),
  );
}

/// One `certificates[]` row: free-text name (with tap-to-fill suggestion
/// chips underneath, NOT a closed-set picker — see the class doc on
/// `TradeFormQualificationsStep.suggestedCertificates`), issuer and year.
class _CertificateCard extends StatefulWidget {
  const _CertificateCard({
    super.key,
    required this.entry,
    required this.suggestions,
    required this.onChanged,
    required this.onRemove,
  });

  final TradeFormCertificateEntry entry;
  final List<String> suggestions;
  final ValueChanged<TradeFormCertificateEntry> onChanged;
  final VoidCallback onRemove;

  @override
  State<_CertificateCard> createState() => _CertificateCardState();
}

class _CertificateCardState extends State<_CertificateCard> {
  late final TextEditingController _name =
      TextEditingController(text: widget.entry.name);
  late final TextEditingController _issuer =
      TextEditingController(text: widget.entry.issuer ?? '');
  late final TextEditingController _year =
      TextEditingController(text: widget.entry.year?.toString() ?? '');
  late String? _yearError = _yearErrorText(_year.text);

  @override
  void dispose() {
    _name.dispose();
    _issuer.dispose();
    _year.dispose();
    super.dispose();
  }

  void _push(TradeFormCertificateEntry next) => widget.onChanged(next);

  /// Chips matching what's typed so far (a substring match, case-insensitive)
  /// — or the first few suggestions when the field is still empty, so a
  /// worker can browse without typing at all.
  List<String> _matchingSuggestions() {
    final String typed = _name.text.trim().toLowerCase();
    final Iterable<String> pool = typed.isEmpty
        ? widget.suggestions
        : widget.suggestions
            .where((String s) => s.toLowerCase().contains(typed));
    return pool.take(_kMaxSuggestionChips).toList();
  }

  void _pickSuggestion(String value) {
    _name.text = value;
    _name.selection = TextSelection.collapsed(offset: value.length);
    setState(() => _push(widget.entry.copyWith(name: value)));
  }

  @override
  Widget build(BuildContext context) {
    final TradeFormCertificateEntry e = widget.entry;
    final List<String> suggestions = _matchingSuggestions();
    return _cardShell(
      onRemove: widget.onRemove,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _fieldLabel(_kCertNameLabel),
          TradeFormTextField(
            controller: _name,
            hint: _kCertNameHint,
            label: _kCertNameLabel,
            maxLength: 120,
            onChanged: (String v) {
              setState(() => _push(e.copyWith(name: v)));
            },
          ),
          if (suggestions.isNotEmpty) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final String s in suggestions)
                  BbChip(
                    label: s,
                    selected: _name.text.trim() == s,
                    onTap: () => _pickSuggestion(s),
                  ),
              ],
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _fieldLabel(_kIssuerLabel),
                    TradeFormTextField(
                      controller: _issuer,
                      hint: _kIssuerHint,
                      label: _kIssuerLabel,
                      maxLength: 120,
                      onChanged: (String v) =>
                          _push(e.copyWith(issuer: _trimOrNull(v))),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    _fieldLabel(_kCertYearLabel),
                    TradeFormTextField(
                      controller: _year,
                      hint: _kCertYearHint,
                      label: _kCertYearLabel,
                      keyboardType: TextInputType.number,
                      textInputAction: TextInputAction.done,
                      errorText: _yearError,
                      onChanged: (String v) => setState(() {
                        _push(e.copyWith(year: _yearInRange(v)));
                        _yearError = _yearErrorText(v);
                      }),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One `educations[]` row: `credential`/`council` render as chip-pickers
/// from the server's own vocabulary (same UX the preferences page already
/// used for the four `education_*` attributes it still writes — see
/// `trade_form_models.dart`'s doc on why this is a SECOND source); `field`/
/// `institute`/`year` are simple text/number entry.
class _EducationCard extends StatefulWidget {
  const _EducationCard({
    super.key,
    required this.entry,
    required this.credentialOptions,
    required this.councilOptions,
    required this.onChanged,
    required this.onRemove,
  });

  final TradeFormEducationEntry entry;
  final Map<String, String> credentialOptions;
  final Map<String, String> councilOptions;
  final ValueChanged<TradeFormEducationEntry> onChanged;
  final VoidCallback onRemove;

  @override
  State<_EducationCard> createState() => _EducationCardState();
}

class _EducationCardState extends State<_EducationCard> {
  late final TextEditingController _field =
      TextEditingController(text: widget.entry.field ?? '');
  late final TextEditingController _year =
      TextEditingController(text: widget.entry.year?.toString() ?? '');
  late final TextEditingController _institute =
      TextEditingController(text: widget.entry.institute ?? '');
  late String? _yearError = _yearErrorText(_year.text);

  @override
  void dispose() {
    _field.dispose();
    _year.dispose();
    _institute.dispose();
    super.dispose();
  }

  void _push(TradeFormEducationEntry next) => widget.onChanged(next);

  Widget _singleChips(
      Map<String, String> labels, String? selected, void Function(String) onTap) {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        for (final MapEntry<String, String> entry in labels.entries)
          BbChip(
            label: entry.value,
            selected: selected == entry.key,
            icon: selected == entry.key ? Icons.check : null,
            onTap: () => onTap(entry.key),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final TradeFormEducationEntry e = widget.entry;
    return _cardShell(
      onRemove: widget.onRemove,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _fieldLabel(_kCredentialLabel),
          _singleChips(
            widget.credentialOptions,
            e.credential,
            (String slug) => setState(() => _push(
                e.copyWith(credential: e.credential == slug ? null : slug))),
          ),
          const SizedBox(height: AppSpacing.s3),
          _fieldLabel(_kFieldLabel),
          TradeFormTextField(
            controller: _field,
            hint: _kFieldHint,
            label: _kFieldLabel,
            maxLength: 80,
            onChanged: (String v) => _push(e.copyWith(field: _trimOrNull(v))),
          ),
          const SizedBox(height: AppSpacing.s3),
          _fieldLabel(_kCouncilLabel),
          _singleChips(
            widget.councilOptions,
            e.council,
            (String slug) => setState(
                () => _push(e.copyWith(council: e.council == slug ? null : slug))),
          ),
          const SizedBox(height: AppSpacing.s3),
          _fieldLabel(_kEduYearLabel),
          TradeFormTextField(
            controller: _year,
            hint: _kEduYearHint,
            label: _kEduYearLabel,
            keyboardType: TextInputType.number,
            textInputAction: TextInputAction.done,
            errorText: _yearError,
            onChanged: (String v) => setState(() {
              _push(e.copyWith(year: _yearInRange(v)));
              _yearError = _yearErrorText(v);
            }),
          ),
          const SizedBox(height: AppSpacing.s3),
          _fieldLabel(_kInstituteLabel),
          TradeFormTextField(
            controller: _institute,
            hint: _kInstituteHint,
            label: _kInstituteLabel,
            maxLength: 120,
            textInputAction: TextInputAction.done,
            onChanged: (String v) =>
                _push(e.copyWith(institute: _trimOrNull(v))),
          ),
        ],
      ),
    );
  }
}
