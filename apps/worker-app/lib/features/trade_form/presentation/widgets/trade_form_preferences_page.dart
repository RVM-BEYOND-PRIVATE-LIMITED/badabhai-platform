import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart'
    show CityOptionDto, WorkPrefOptionsDto;
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/widgets/bb_searchable_dropdown_field.dart';
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
const String _kCitiesSubtitle = 'Zyada se zyada 5 sheher jod sakte hain.';
const String _kStateLabel = 'State';
const String _kPickStateLabel = 'STATE CHUNEIN';
const String _kCityHint = 'Sheher ka naam likhein';
const String _kCityNotFoundError =
    'Yeh sheher list mein nahi mila — neeche diye suggestion mein se chunein.';
const String _kCityAddedToast = 'Sheher add ho gaya';

/// The tap-to-add suggestion row shows at most this many cities at once —
/// mirrors `_kMaxSuggestionChips` on the qualifications page's certificate
/// suggestions (a low-literacy worker scanning a phone screen, not a full
/// picklist).
const int _kMaxCitySuggestions = 6;
const String _kRelocateLabel = 'Doosre sheher ja sakte hain?';
const String _kAccommodationLabel = 'Rehne ki jagah chahiye?';
const String _kSalaryLabel = 'Mahine ki salary kitni chahte hain?';
const String _kOptionalNote = 'Jo laagu ho, wahi bharein — sab optional hai.';

const Map<int, String> _kSalaryBands = <int, String>{
  15000: '₹10–15 hazaar',
  20000: '₹15–20 hazaar',
  25000: '₹20–25 hazaar',
  35000: '₹25–35 hazaar',
  50000: '₹35–50 hazaar',
  100000: '₹50 hazaar se upar',
};

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
  /// Page 0: languages · 1: documents · 2: shift · 3: job type · 4: cities ·
  /// 5: relocate + accommodation + salary. Every one of these used to share a
  /// page with at least one other question — languages+documents, then
  /// shift+jobType+cities — until the owner flagged a worker facing more than
  /// one question at a time as a single wall. Fixed count — this marker's
  /// field groups never change size at runtime (contrast
  /// `TradeFormEmploymentPageState.pageCount`, which is driven by a
  /// repeat-row list).
  ///
  /// USED TO carry 3 more pages (credential / council / kis saal poora hua +
  /// institute) — dropped because they asked the SAME "ITI ya Diploma?"
  /// question the `qualifications` marker's education entries already ask,
  /// on a DIFFERENT screen with a DIFFERENT vocabulary
  /// (`EDUCATION_CREDENTIALS` here vs `EDUCATION_QUALIFICATIONS` there). The
  /// qualifications marker is the one kept; backend cleanup of the now-dead
  /// `work_preferences.education_*` columns is tracked for Prakash.
  static const int pageCount = 6;

  WorkPrefOptionsDto? _options;
  String? _loadError;
  late TradeFormPreferences _prefs =
      widget.initialPreferences ?? const TradeFormPreferences();

  final TextEditingController _city = TextEditingController();

  /// Set when submitted text doesn't resolve against the server's gazetteer
  /// (`options.cities`) — never a bare string add any more (#1406/#1410):
  /// the server's `preferred_cities` 400s on anything outside the same
  /// catalogue, so accepting an unresolved city client-side would just move
  /// the dead end from submit-time to save-time.
  String? _cityError;

  /// The state currently narrowing the city search (#1429) — a PURE UI
  /// filter, never part of [_prefs]/the write contract (`preferred_cities`
  /// still submits the city's [CityOptionDto.value] alone). Null means no
  /// state picked yet, so the city search stays closed (see [_citiesPage]).
  String? _cityState;

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
    super.dispose();
  }

  /// Called by the screen's sticky bottom bar ONLY on this marker's LAST
  /// internal page — see `_WizardScaffoldState`'s routing.
  void save() => widget.onSave(_prefs);

  /// No page on this marker can be entered wrong any more — every field is
  /// closed-set chips/toggles/a resolved-city picker. (The one free-typed
  /// field that COULD fail, the education year, left with the education
  /// pages — see `pageCount`'s doc.) Checked by `_WizardScaffoldState` before
  /// [goToNextPage]/[save] for every marker, so this stays a real method
  /// rather than being dropped from the shared interface.
  String? currentPageError() => null;

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
        return _languagesPage(options);
      case 1:
        return _documentsPage(options);
      case 2:
        return _shiftPage(options);
      case 3:
        return _jobTypePage(options);
      case 4:
        return _citiesPage(options);
      default:
        return _relocateAccommodationSalaryPage();
    }
  }

  Widget _languagesPage(WorkPrefOptionsDto options) {
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
      ],
    );
  }

  Widget _documentsPage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(_kOptionalNote,
            style: AppTypography.body(
                size: AppTypography.sizeSm, color: AppColors.textMuted)),
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

  Widget _citiesPage(WorkPrefOptionsDto options) {
    final bool atCityCap =
        _prefs.preferredCities.length >= kTradeFormMaxPreferredCities;
    final List<CityOptionDto> suggestions = _matchingCities(options);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _label(_kCitiesLabel),
        Text(_kCitiesSubtitle,
            style: AppTypography.body(
                size: AppTypography.sizeSm, color: AppColors.textMuted)),
        const SizedBox(height: AppSpacing.s3),
        // The add row itself IS this section's "add another" affordance —
        // there's no per-city card to hide, so the row disappears at the
        // cap, same convention as `kTradeFormMaxCertificates`/
        // `kTradeFormMaxEducations`'s add button.
        if (!atCityCap) ...<Widget>[
          // State-then-city cascade (#1429): the state list picks which
          // state's cities the search below offers — no "+" add button, a
          // worker cannot enter a custom city (the server's gazetteer is
          // closed, #1406/#1410), so the ONLY way to add one is picking a
          // suggestion chip below (or hitting the keyboard's "Done", which
          // resolves the same exact-match check a "+" button would have).
          _label(_kStateLabel),
          BbSearchableDropdownField(
            placeholder: _kPickStateLabel,
            options: options.states,
            selected: _cityState,
            onSelected: (String state) => setState(() {
              _cityState = state;
              _city.clear();
              _cityError = null;
            }),
          ),
          if (_cityState != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            TradeFormTextField(
              controller: _city,
              hint: _kCityHint,
              textInputAction: TextInputAction.done,
              errorText: _cityError,
              onChanged: (String v) => setState(() => _cityError = null),
              onSubmitted: (_) => _submitTypedCity(options),
            ),
            if (suggestions.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.s2),
              Wrap(
                spacing: AppSpacing.s2,
                runSpacing: AppSpacing.s2,
                children: <Widget>[
                  for (final CityOptionDto c in suggestions)
                    BbChip(label: c.value, onTap: () => _addResolvedCity(c)),
                ],
              ),
            ],
          ],
        ],
        if (_prefs.preferredCities.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          // Horizontal `ListView.builder`, not a `Wrap` — a picked-cities row
          // scrolls sideways instead of stacking to a second line, so it
          // reads the same as every other horizontally-scrolling chip row in
          // the app (the job feed's header filters).
          SizedBox(
            height: AppSpacing.tap,
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              itemCount: _prefs.preferredCities.length,
              itemBuilder: (BuildContext context, int index) {
                final String c = _prefs.preferredCities[index];
                final bool isLast =
                    index == _prefs.preferredCities.length - 1;
                return Padding(
                  padding: EdgeInsets.only(
                      right: isLast ? 0 : AppSpacing.s2),
                  child: BbChip(
                    label: c,
                    selected: true,
                    icon: Icons.close,
                    onTap: () => setState(() => _prefs = _prefs.copyWith(
                        preferredCities: _prefs.preferredCities
                            .where((String x) => x != c)
                            .toList())),
                  ),
                );
              },
            ),
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

  /// Chips matching what's typed so far against BOTH `value` and its
  /// `aliases` (a worker typing "dilli"/"bombay"/"banglore"/"poona" must
  /// still find the city) — or the first few when the field is empty, so a
  /// worker can browse without typing at all. Already-picked cities are
  /// dropped from the pool; there is no reason to suggest adding one twice.
  ///
  /// FILTERED TO [_cityState] FIRST (#1429) — the state-then-city cascade;
  /// empty when no state is picked yet (the caller doesn't even show the
  /// search box in that case — see [_citiesPage]).
  List<CityOptionDto> _matchingCities(WorkPrefOptionsDto options) {
    final String? state = _cityState;
    if (state == null) return const <CityOptionDto>[];
    final String typed = _city.text.trim().toLowerCase();
    final Set<String> picked =
        _prefs.preferredCities.map((String c) => c.toLowerCase()).toSet();
    final Iterable<CityOptionDto> pool = options.cities.where(
      (CityOptionDto c) =>
          c.state == state &&
          !picked.contains(c.value.toLowerCase()) &&
          (typed.isEmpty ||
              c.value.toLowerCase().contains(typed) ||
              c.aliases.any((String a) => a.toLowerCase().contains(typed))),
    );
    return pool.take(_kMaxCitySuggestions).toList();
  }

  /// Resolves typed text against the gazetteer — an exact match (`value` OR
  /// any `alias`, case-insensitive), WITHIN [_cityState] — or null. There is
  /// no fuzzy/partial accept: [_matchingCities] is how a worker finds the
  /// right chip to tap, this is only for pressing "+"/submit with the full
  /// name already typed. Scoped to the picked state so typing an exact city
  /// name that belongs to a DIFFERENT state is treated as not-found rather
  /// than silently resolving against the wrong cascade branch.
  CityOptionDto? _resolveCity(WorkPrefOptionsDto options, String typed) {
    final String? state = _cityState;
    if (state == null) return null;
    final String q = typed.trim().toLowerCase();
    if (q.isEmpty) return null;
    for (final CityOptionDto c in options.cities) {
      if (c.state != state) continue;
      if (c.value.toLowerCase() == q) return c;
      if (c.aliases.any((String a) => a.toLowerCase() == q)) return c;
    }
    return null;
  }

  void _submitTypedCity(WorkPrefOptionsDto options) {
    final String typed = _city.text.trim();
    if (typed.isEmpty) return;
    final CityOptionDto? resolved = _resolveCity(options, typed);
    if (resolved == null) {
      setState(() => _cityError = _kCityNotFoundError);
      return;
    }
    _addResolvedCity(resolved);
  }

  /// Adds the CANONICAL `value` — never the raw typed text — so
  /// `preferred_cities` always sends exactly the spelling the server's own
  /// validator already accepted (`worker-cities.catalogue.ts`'s round-trip
  /// guarantee). Shared by the "+"/submit path (after [_resolveCity]) and a
  /// direct tap on a suggestion chip (already resolved).
  void _addResolvedCity(CityOptionDto city) {
    if (_prefs.preferredCities.length >= kTradeFormMaxPreferredCities) return;
    final bool exists = _prefs.preferredCities
        .any((String c) => c.toLowerCase() == city.value.toLowerCase());
    setState(() {
      _cityError = null;
      if (!exists) {
        _prefs = _prefs.copyWith(
            preferredCities: <String>[..._prefs.preferredCities, city.value]);
      }
    });
    _city.clear();
    if (exists) return; // already in the list — nothing new happened
    // A MaterialBanner (top), NOT a SnackBar — this screen's sticky bottom
    // bar owns the bottom edge (see `trade_form_screen.dart`'s
    // `_showBlockedBanner` doc: a SnackBar here would animate up from the
    // bottom and cover "Aage badhein").
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger.clearMaterialBanners();
    messenger.showMaterialBanner(
      MaterialBanner(
        backgroundColor: AppColors.success,
        content: Text(_kCityAddedToast,
            style: AppTypography.body(
                size: AppTypography.sizeSm, color: Colors.white)),
        actions: <Widget>[
          TextButton(
            onPressed: messenger.hideCurrentMaterialBanner,
            child: const Text('Theek hai',
                style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
          ),
        ],
      ),
    );
    Future<void>.delayed(const Duration(seconds: 2), () {
      if (mounted) messenger.hideCurrentMaterialBanner();
    });
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
