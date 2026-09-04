import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart' show QualificationOptionsDto;
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/title_case.dart';
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

/// Shown by the wizard's top banner when "Aage badhein" is blocked — the
/// inline red text under the field already says WHICH year is wrong; this
/// only needs to say why the tap did nothing.
const String _kBlockedAdvanceMessage =
    'Sahi saal daalein — tabhi aage badh sakte hain.';

/// The tap-to-fill suggestion row shows at most this many chips at once — a
/// low-literacy worker scanning a phone screen, not a full picklist.
const int _kMaxSuggestionChips = 6;

/// The `type: "qualifications"` marker screen (#1384/#1385, migration 0098)
/// — the certificates + education rows `PUT /workers/me/qualifications`
/// owns. Two independent repeatable sections, mirroring
/// `TradeFormEmploymentPage`'s add/remove-row pattern.
///
/// #1384 item 2 — the two sections are now separate INTERNAL pages rather
/// than stacked on one scroll; education is further split into 3 pages
/// (credential+subject / council / kis saal poora hua+institute) — a worker
/// facing 5 education questions at once was a single wall, same reasoning
/// as every other multi-field marker page in this app.
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
  /// same contract, off a fixed [pageCount] of 4 (certificates, then
  /// education's credential+subject / council / year+institute).
  final void Function(int page, int pageCount)? onPageChanged;

  @override
  State<TradeFormQualificationsPage> createState() =>
      TradeFormQualificationsPageState();
}

class TradeFormQualificationsPageState
    extends State<TradeFormQualificationsPage> {
  /// Page 0: certificates · 1: education credential+subject · 2: education
  /// council · 3: kis saal poora hua+institute. Fixed — this marker's
  /// sub-sections never change count at runtime (only the REPEATED rows
  /// within education do, tracked separately below).
  static const int pageCount = 4;

  QualificationOptionsDto? _options;
  String? _optionsLoadError;

  late List<TradeFormCertificateEntry> _certificates =
      List<TradeFormCertificateEntry>.of(
          widget.initialQualifications?.certificates ??
              const <TradeFormCertificateEntry>[]);
  late bool _certificatesTouched =
      widget.initialQualifications?.certificatesTouched ?? false;

  /// True while ANY certificate card currently shows a year error — tracked
  /// here (not just inside each card) so the wizard's "Aage badhein" can be
  /// blocked from the outside; see [currentPageError].
  final Set<int> _certYearErrorIndices = <int>{};

  late List<TradeFormEducationEntry> _educations = List<TradeFormEducationEntry>.of(
      widget.initialQualifications?.educations ??
          const <TradeFormEducationEntry>[]);
  late bool _educationsTouched =
      widget.initialQualifications?.educationsTouched ?? false;

  /// Education's field/year/institute controllers are OWNED HERE, not by a
  /// per-row child widget — the education section now spans 3 internal
  /// pages (credential+subject / council / year+institute), and a row's
  /// typed text must survive walking between them. A child `StatefulWidget`
  /// rebuilt fresh per page would lose it; keeping the controllers in this
  /// State (which stays mounted for the marker's whole internal walk) is
  /// the same fix `TradeFormPreferencesPageState` already uses for its own
  /// (non-repeated) year/institute fields.
  late final List<TextEditingController> _eduFieldControllers =
      <TextEditingController>[
    for (final TradeFormEducationEntry e in _educations)
      TextEditingController(text: e.field ?? ''),
  ];
  late final List<TextEditingController> _eduYearControllers =
      <TextEditingController>[
    for (final TradeFormEducationEntry e in _educations)
      TextEditingController(text: e.year?.toString() ?? ''),
  ];
  late final List<TextEditingController> _eduInstituteControllers =
      <TextEditingController>[
    for (final TradeFormEducationEntry e in _educations)
      TextEditingController(text: e.institute ?? ''),
  ];
  late final List<String?> _eduYearErrors = <String?>[
    for (final TextEditingController c in _eduYearControllers)
      _yearErrorText(c.text),
  ];

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

  @override
  void dispose() {
    for (final TextEditingController c in _eduFieldControllers) {
      c.dispose();
    }
    for (final TextEditingController c in _eduYearControllers) {
      c.dispose();
    }
    for (final TextEditingController c in _eduInstituteControllers) {
      c.dispose();
    }
    super.dispose();
  }

  void goToNextPage() {
    if (isLastPage) return;
    setState(() => _page += 1);
    widget.onPageChanged?.call(_page, pageCount);
  }

  /// The CURRENT internal page's blocking validation message, or null.
  /// Checked by `_WizardScaffoldState` BEFORE calling [goToNextPage]/[save]
  /// — a red year with no way to stop "Aage badhein" was a real, reported
  /// bug (a future year showed the inline error and still let the worker
  /// through). Page 0 (certificates) can fail on ANY card's year; the last
  /// page (year+institute) can fail on any education row's year — every
  /// other page is closed-set chips/free text with no year field.
  String? currentPageError() {
    if (_page == 0) {
      return _certYearErrorIndices.isNotEmpty ? _kBlockedAdvanceMessage : null;
    }
    if (_page == pageCount - 1) {
      return _eduYearErrors.any((String? e) => e != null)
          ? _kBlockedAdvanceMessage
          : null;
    }
    return null;
  }

  void _onCertYearValidity(int index, bool hasError) {
    setState(() {
      if (hasError) {
        _certYearErrorIndices.add(index);
      } else {
        _certYearErrorIndices.remove(index);
      }
    });
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
      // Cards are keyed by POSITION (`ValueKey<int>(i)`), so a removal
      // reshuffles every later card onto a different key — each one remounts
      // fresh and reports its own validity again. Stale indices here would
      // otherwise wrongly keep the wizard blocked (or wrongly unblock it).
      _certYearErrorIndices.clear();
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
      _eduFieldControllers.add(TextEditingController());
      _eduYearControllers.add(TextEditingController());
      _eduInstituteControllers.add(TextEditingController());
      _eduYearErrors.add(null);
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
      _eduFieldControllers.removeAt(index).dispose();
      _eduYearControllers.removeAt(index).dispose();
      _eduInstituteControllers.removeAt(index).dispose();
      _eduYearErrors.removeAt(index);
    });
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: _pageContent(),
      ),
    );
  }

  Widget _pageContent() {
    switch (_page) {
      case 0:
        return _certificatesPage();
      case 1:
        return _educationPage(
          title: _kEduTitle,
          subtitle: _kEduSubtitle,
          section: _EduSection.credentialAndField,
        );
      case 2:
        return _educationPage(section: _EduSection.council);
      default:
        return _educationPage(section: _EduSection.yearAndInstitute);
    }
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
            onValidityChanged: (bool hasError) =>
                _onCertYearValidity(i, hasError),
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

  /// One of the education marker's 3 internal pages — [title]/[subtitle]
  /// (the heading + "up to 4 entries" note) render only on the FIRST of the
  /// three, matching how the certificates page has exactly one heading; the
  /// other two are a continuation of the same section, not a new one.
  Widget _educationPage({
    String? title,
    String? subtitle,
    required _EduSection section,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (title != null) ...<Widget>[
          Text(title, style: AppTypography.display(size: AppTypography.sizeLg)),
          const SizedBox(height: AppSpacing.s2),
        ],
        if (subtitle != null) ...<Widget>[
          Text(subtitle,
              style: AppTypography.body(
                  size: AppTypography.sizeSm, color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s4),
        ],
        _educationSection(section),
      ],
    );
  }

  Widget _educationSection(_EduSection section) {
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
          _cardShell(
            onRemove: () => _removeEducation(i),
            child: _educationRow(i, options, section),
          ),
          const SizedBox(height: AppSpacing.s3),
        ],
        // The "add another" affordance lives on the FIRST education
        // sub-page only — that is where a new, blank entry actually starts
        // making sense (it has no credential yet); offering "add" on the
        // council or year+institute page would drop a blank card into a
        // page that cannot fill it in.
        if (section == _EduSection.credentialAndField &&
            _educations.length < kTradeFormMaxEducations)
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

  Widget _educationRow(
      int i, QualificationOptionsDto options, _EduSection section) {
    final TradeFormEducationEntry e = _educations[i];
    switch (section) {
      case _EduSection.credentialAndField:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _fieldLabel(_kCredentialLabel),
            _eduSingleChips(
              options.educationCredential,
              e.credential,
              (String slug) => _updateEducation(i,
                  e.copyWith(credential: e.credential == slug ? null : slug)),
            ),
            const SizedBox(height: AppSpacing.s3),
            _fieldLabel(_kFieldLabel),
            TradeFormTextField(
              controller: _eduFieldControllers[i],
              hint: _kFieldHint,
              label: _kFieldLabel,
              maxLength: 80,
              onChanged: (String v) =>
                  _updateEducation(i, e.copyWith(field: _titleCaseOrNull(v))),
            ),
          ],
        );
      case _EduSection.council:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _fieldLabel(_kCouncilLabel),
            _eduSingleChips(
              options.educationCouncil,
              e.council,
              (String slug) => _updateEducation(
                  i, e.copyWith(council: e.council == slug ? null : slug)),
            ),
          ],
        );
      case _EduSection.yearAndInstitute:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _fieldLabel(_kEduYearLabel),
            TradeFormTextField(
              controller: _eduYearControllers[i],
              hint: _kEduYearHint,
              label: _kEduYearLabel,
              keyboardType: TextInputType.number,
              textInputAction: TextInputAction.done,
              errorText: _eduYearErrors[i],
              onChanged: (String v) => setState(() {
                _eduYearErrors[i] = _yearErrorText(v);
                _updateEducation(i, e.copyWith(year: _yearInRange(v)));
              }),
            ),
            const SizedBox(height: AppSpacing.s3),
            _fieldLabel(_kInstituteLabel),
            TradeFormTextField(
              controller: _eduInstituteControllers[i],
              hint: _kInstituteHint,
              label: _kInstituteLabel,
              maxLength: 120,
              textInputAction: TextInputAction.done,
              onChanged: (String v) =>
                  _updateEducation(i, e.copyWith(institute: _titleCaseOrNull(v))),
            ),
          ],
        );
    }
  }

  Widget _eduSingleChips(
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
}

/// Which fields an education row shows on THIS internal page — see
/// `TradeFormQualificationsPageState.pageCount`'s doc.
enum _EduSection { credentialAndField, council, yearAndInstitute }

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

/// [_trimOrNull], plus [titleCaseName] — for the institute and trade/subject
/// fields (both short proper-noun-like labels, e.g. "electric" -> "Electric").
/// Certificate name/issuer stays on [_trimOrNull] verbatim, along with every
/// genuine free-text description elsewhere in this walk: title-casing is
/// never applied to a description a worker wrote in their own words.
String? _titleCaseOrNull(String v) {
  final String? trimmed = _trimOrNull(v);
  return trimmed == null ? null : titleCaseName(trimmed);
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
    this.onValidityChanged,
  });

  final TradeFormCertificateEntry entry;
  final List<String> suggestions;
  final ValueChanged<TradeFormCertificateEntry> onChanged;
  final VoidCallback onRemove;

  /// Fires whenever this card's year field flips between valid/invalid —
  /// the parent (this marker's own page, not a per-card concern) uses it to
  /// block "Aage badhein" on page 0; see
  /// `TradeFormQualificationsPageState.currentPageError`.
  final ValueChanged<bool>? onValidityChanged;

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
                      onChanged: (String v) {
                        final String? next = _yearErrorText(v);
                        final bool flipped = (next != null) != (_yearError != null);
                        setState(() {
                          _push(e.copyWith(year: _yearInRange(v)));
                          _yearError = next;
                        });
                        if (flipped) widget.onValidityChanged?.call(next != null);
                      },
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

