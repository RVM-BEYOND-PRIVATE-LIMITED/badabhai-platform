import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart' show WorkPrefOptionsDto;
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_toggle.dart';
import '../../domain/trade_form_models.dart';
import 'trade_form_text_field.dart';

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kLangLabel = 'Aap kaun si bhasha bolte hain?';
const String _kDocLabel = 'Kaun se document taiyaar hain?';
const String _kShiftLabel = 'Shift';
const String _kJobTypeLabel = 'Naukri ka type';
const String _kCitiesLabel = 'Kahan kaam karna chahte hain?';
const String _kCityHint = 'Sheher ka naam likhein';
const String _kRelocateLabel = 'Doosre sheher ja sakte hain?';
const String _kAccommodationLabel = 'Rehne ki jagah chahiye?';
const String _kSalaryLabel = 'Mahine ki salary kitni chahte hain?';
const String _kCredentialLabel = 'Agar ITI ya Diploma hai to kaun sa?';
const String _kCouncilLabel = 'Council / board';
const String _kEduYearLabel = 'Kis saal poora hua';
const String _kEduYearHint = 'Jaise: 2018';
const String _kInstituteLabel = 'Institute ka naam';
const String _kInstituteHint = 'Jaise: Govt. ITI, Faridabad';
const String _kOptionalNote = 'Jo laagu ho, wahi bharein — sab optional hai.';

// #1298's education vocabularies are not served by an options endpoint, so
// they are pinned here from the authoritative source
// (apps/api/src/profiles/worker-preferences.vocabulary.ts), same as
// `features/finishing` does today.
const Map<String, String> _kCredentials = <String, String>{
  'iti': 'ITI',
  'diploma': 'Diploma',
};
const Map<String, String> _kCouncils = <String, String>{
  'ncvt': 'NCVT',
  'scvt': 'SCVT',
  'nsqf': 'NSQF',
  'aicte': 'AICTE',
  'state_board': 'State board',
  'cbse': 'CBSE',
  'icse': 'ICSE',
  'open_school': 'NIOS / Open school',
};

const Map<int, String> _kSalaryBands = <int, String>{
  15000: '₹10–15 hazaar',
  20000: '₹15–20 hazaar',
  25000: '₹20–25 hazaar',
  35000: '₹25–35 hazaar',
  50000: '₹35–50 hazaar',
  100000: '₹50 hazaar se upar',
};

const int _kYearMin = 1950;
const String _kYearFutureError = 'Yeh saal abhi aaya nahi — sahi saal likhein';
const String _kYearInvalidError = 'Sahi saal likhein';

/// The `type: "preferences"` marker screen (#1341) — the closed-set fields
/// `PUT /workers/me/work-preferences` owns. #1384 item 2 split what was
/// originally ONE long scrollable page (rather than `features/finishing`'s
/// five-page wizard — that feature is out of scope here; see
/// `trade_form_models.dart`'s doc on the deliberate duplication) into FOUR
/// short INTERNAL pages, walked via [goToNextPage]/[goToPreviousPage] — see
/// this class' own doc for why the pagination lives entirely inside this
/// widget rather than growing `TradeFormCubit.flatSteps`. Every field stays
/// optional; this is a scroll-length change, not a scope cut.
class TradeFormPreferencesPage extends StatefulWidget {
  const TradeFormPreferencesPage({
    super.key,
    required this.loadOptions,
    required this.enabled,
    required this.onSave,
    this.initialPreferences,
    this.onPageChanged,
  });

  final Future<WorkPrefOptionsDto> Function() loadOptions;
  final bool enabled;
  final ValueChanged<TradeFormPreferences> onSave;

  /// The cubit's own memory of the last successful save for THIS marker
  /// (#1384 item 1, `TradeFormState.savedPreferences`) — null the first time
  /// a worker ever reaches this screen, non-null when they `goBack()` into
  /// an already-passed one. Seeds every field below instead of the blank
  /// constructor default, which is what a bare `GlobalKey` cannot do once
  /// this widget has been fully unmounted (see the doc on
  /// `TradeFormState.savedPreferences`).
  final TradeFormPreferences? initialPreferences;

  /// #1384 item 2 — reports `(currentPage, pageCount)` every time this
  /// widget's OWN internal page changes, including once right after this
  /// widget's first frame. `trade_form_screen.dart` uses it to decide what
  /// the ONE shared sticky bottom bar should do on tap (advance an internal
  /// page vs the true save-and-advance-the-outer-walk) and how the header's
  /// back arrow should behave — see `_WizardScaffoldState`'s own doc. Null is
  /// fine for a test that constructs this page directly and does not care;
  /// every production call site passes one.
  final void Function(int page, int pageCount)? onPageChanged;

  @override
  State<TradeFormPreferencesPage> createState() =>
      TradeFormPreferencesPageState();
}

class TradeFormPreferencesPageState extends State<TradeFormPreferencesPage> {
  /// Page 0: languages + documents · 1: shift · 2: job type · 3: cities ·
  /// 4: relocate + accommodation + salary · 5: education. Shift, job type
  /// and cities were one shared page until the owner flagged a worker
  /// facing all three questions at once as a single wall — each is its own
  /// internal page now. Fixed count — this marker's field groups never
  /// change size at runtime (contrast `TradeFormEmploymentPageState.pageCount`,
  /// which is driven by a repeat-row list).
  static const int pageCount = 6;

  WorkPrefOptionsDto? _options;
  String? _loadError;
  late TradeFormPreferences _prefs =
      widget.initialPreferences ?? const TradeFormPreferences();

  final TextEditingController _city = TextEditingController();
  late final TextEditingController _year = TextEditingController(
      text: widget.initialPreferences?.educationYear?.toString() ?? '');
  late final TextEditingController _institute = TextEditingController(
      text: widget.initialPreferences?.educationInstitute ?? '');
  late String? _yearError = _yearErrorText(_year.text);

  int _page = 0;
  bool get isFirstPage => _page <= 0;
  bool get isLastPage => _page >= pageCount - 1;

  @override
  void initState() {
    super.initState();
    _load();
    // The parent cannot be told about a child's state from inside the
    // child's OWN build phase — deferred to right after the first frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.onPageChanged?.call(_page, pageCount);
    });
  }

  Future<void> _load() async {
    try {
      final WorkPrefOptionsDto options = await widget.loadOptions();
      if (!mounted) return;
      setState(() {
        _options = options;
        _loadError = null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadError = 'Kuch gadbad ho gayi. Dobara koshish karein.');
    }
  }

  @override
  void dispose() {
    _city.dispose();
    _year.dispose();
    _institute.dispose();
    super.dispose();
  }

  /// Called by the screen's sticky bottom bar ONLY on this marker's LAST
  /// internal page — see `_WizardScaffoldState`'s routing.
  void save() => widget.onSave(_prefs);

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

  Set<String> _toggled(Set<String> set, String slug) {
    final Set<String> next = Set<String>.of(set);
    if (!next.add(slug)) next.remove(slug);
    return next;
  }

  /// Floor `1950`, ceiling TODAY'S year, not the server's fixed `2100` — an
  /// education cannot complete in the future, so the client shouldn't
  /// produce a value the server would only accept because its own bound is
  /// far looser.
  int? _yearInRange(String s) {
    final int? v = int.tryParse(s.trim());
    if (v == null || v < _kYearMin || v > DateTime.now().year) return null;
    return v;
  }

  /// Inline message for the year field, or null while still valid
  /// (including mid-typing a 4-digit year).
  static String? _yearErrorText(String s) {
    final String t = s.trim();
    if (t.length < 4) return null;
    if (t.length > 4) return _kYearInvalidError;
    final int? v = int.tryParse(t);
    if (v == null) return _kYearInvalidError;
    if (v > DateTime.now().year) return _kYearFutureError;
    if (v < _kYearMin) return _kYearInvalidError;
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final WorkPrefOptionsDto? options = _options;
    if (_loadError != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(_loadError!, style: AppTypography.body(size: AppTypography.sizeBase)),
          const SizedBox(height: AppSpacing.s3),
          BbButton(
            label: 'Dobara koshish karein',
            variant: BbButtonVariant.secondary,
            onPressed: _load,
          ),
        ],
      );
    }
    if (options == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(AppSpacing.s6),
          child: CircularProgressIndicator(color: AppColors.blue),
        ),
      );
    }
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: _pageContent(options),
      ),
    );
  }

  Widget _pageContent(WorkPrefOptionsDto options) {
    switch (_page) {
      case 0:
        return _languagesAndDocumentsPage(options);
      case 1:
        return _shiftPage(options);
      case 2:
        return _jobTypePage(options);
      case 3:
        return _citiesPage();
      case 4:
        return _relocateAccommodationSalaryPage();
      default:
        return _educationPage();
    }
  }

  Widget _languagesAndDocumentsPage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(_kOptionalNote,
            style: AppTypography.body(
                size: AppTypography.sizeSm, color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s5),
        _label(_kLangLabel),
        _multiChips(options.languages, _prefs.languages,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                languages: _toggled(_prefs.languages, slug)))),
        const SizedBox(height: AppSpacing.s5),
        _label(_kDocLabel),
        _multiChips(options.documentsReady, _prefs.documentsReady,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                documentsReady: _toggled(_prefs.documentsReady, slug)))),
      ],
    );
  }

  Widget _shiftPage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _label(_kShiftLabel),
        _singleChips(options.shift, _prefs.shift,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                shift: _prefs.shift == slug ? null : slug))),
      ],
    );
  }

  Widget _jobTypePage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _label(_kJobTypeLabel),
        _singleChips(options.jobType, _prefs.jobType,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                jobType: _prefs.jobType == slug ? null : slug))),
      ],
    );
  }

  Widget _citiesPage() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _label(_kCitiesLabel),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: TradeFormTextField(
                controller: _city,
                hint: _kCityHint,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _addCity(),
              ),
            ),
            const SizedBox(width: AppSpacing.s2),
            BbButton(
              label: '+',
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.md,
              onPressed: _addCity,
            ),
          ],
        ),
        if (_prefs.preferredCities.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final String c in _prefs.preferredCities)
                BbChip(
                  label: c,
                  selected: true,
                  icon: Icons.close,
                  onTap: () => setState(() => _prefs = _prefs.copyWith(
                      preferredCities: _prefs.preferredCities
                          .where((String x) => x != c)
                          .toList())),
                ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _relocateAccommodationSalaryPage() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _toggleRow(_kRelocateLabel, _prefs.willingToRelocate,
            (bool v) => setState(() => _prefs = _prefs.copyWith(willingToRelocate: v))),
        const SizedBox(height: AppSpacing.s3),
        _toggleRow(_kAccommodationLabel, _prefs.accommodationNeeded,
            (bool v) => setState(() => _prefs = _prefs.copyWith(accommodationNeeded: v))),
        const SizedBox(height: AppSpacing.s5),
        _label(_kSalaryLabel),
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            for (final MapEntry<int, String> e in _kSalaryBands.entries)
              BbChip(
                label: e.value,
                selected: _prefs.salaryExpectedMax == e.key,
                icon: _prefs.salaryExpectedMax == e.key ? Icons.check : null,
                onTap: () => setState(() => _prefs = _prefs.copyWith(
                    salaryExpectedMax:
                        _prefs.salaryExpectedMax == e.key ? null : e.key)),
              ),
          ],
        ),
      ],
    );
  }

  Widget _educationPage() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _label(_kCredentialLabel),
        _singleChips(_kCredentials, _prefs.educationCredential,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                educationCredential:
                    _prefs.educationCredential == slug ? null : slug))),
        const SizedBox(height: AppSpacing.s5),
        _label(_kCouncilLabel),
        _singleChips(_kCouncils, _prefs.educationCouncil,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                educationCouncil:
                    _prefs.educationCouncil == slug ? null : slug))),
        const SizedBox(height: AppSpacing.s5),
        _label(_kEduYearLabel),
        TradeFormTextField(
          controller: _year,
          hint: _kEduYearHint,
          label: _kEduYearLabel,
          keyboardType: TextInputType.number,
          errorText: _yearError,
          onChanged: (String v) => setState(() {
            _prefs = _prefs.copyWith(educationYear: _yearInRange(v));
            _yearError = _yearErrorText(v);
          }),
        ),
        const SizedBox(height: AppSpacing.s5),
        _label(_kInstituteLabel),
        TradeFormTextField(
          controller: _institute,
          hint: _kInstituteHint,
          label: _kInstituteLabel,
          maxLength: 120,
          textInputAction: TextInputAction.done,
          onChanged: (String v) {
            final String trimmed = v.trim();
            setState(() => _prefs = _prefs.copyWith(
                educationInstitute: trimmed.isEmpty ? null : trimmed));
          },
        ),
      ],
    );
  }

  void _addCity() {
    final String value = _city.text.trim();
    if (value.isEmpty) return;
    final bool exists = _prefs.preferredCities
        .any((String c) => c.toLowerCase() == value.toLowerCase());
    if (!exists) {
      setState(() => _prefs = _prefs.copyWith(
          preferredCities: <String>[..._prefs.preferredCities, value]));
    }
    _city.clear();
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.s2),
        child: Text(text, style: AppTypography.eyebrow()),
      );

  Widget _multiChips(
      Map<String, String> labels, Set<String> selected, void Function(String) onTap) {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        for (final MapEntry<String, String> e in labels.entries)
          BbChip(
            label: e.value,
            selected: selected.contains(e.key),
            icon: selected.contains(e.key) ? Icons.check : null,
            onTap: () => onTap(e.key),
          ),
      ],
    );
  }

  Widget _singleChips(
      Map<String, String> labels, String? selected, void Function(String) onTap) {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        for (final MapEntry<String, String> e in labels.entries)
          BbChip(
            label: e.value,
            selected: selected == e.key,
            icon: selected == e.key ? Icons.check : null,
            onTap: () => onTap(e.key),
          ),
      ],
    );
  }

  Widget _toggleRow(String label, bool value, ValueChanged<bool> onChanged) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(label, style: AppTypography.body(size: AppTypography.sizeBase)),
        ),
        const SizedBox(width: AppSpacing.s2),
        BbToggle(value: value, onChanged: onChanged, semanticLabel: label),
      ],
    );
  }
}
