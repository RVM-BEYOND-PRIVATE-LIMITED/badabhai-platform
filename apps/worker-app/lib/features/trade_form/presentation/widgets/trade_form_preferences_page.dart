import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart'
    show CityOptionDto, WorkPrefOptionsDto;
import '../../../../core/session/known_worker_facts_store.dart' show WorkerFact;
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/form_flow_parts.dart';
import '../../../../core/widgets/onboarding/onboarding_select_field.dart';
import '../../../../core/widgets/onboarding/option_icons.dart';
import '../../../../core/widgets/onboarding/selection_cards.dart';
import '../../domain/trade_form_models.dart';
import 'trade_form_kit.dart';
import 'trade_form_text_field.dart';

/// The tile glyph for one option card, from its slug and label.
typedef _OptionIcon = IconData Function(String optionKey, String label);

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kLangLabel = 'Aap kaun si bhasha bolte hain?';
const String _kDocLabel = 'Kaun se document taiyaar hain?';
const String _kShiftLabel = 'Shift';
const String _kJobTypeLabel = 'Naukri ka type';
const String _kCitiesLabel = 'Kahan kaam karna chahte hain?';
const String _kCitiesSubtitle = 'Zyada se zyada 5 sheher jod sakte hain.';
const String _kStateLabel = 'State (Rajya)';
const String _kCityLabel = 'Sheher (City)';
const String _kPickStateLabel = 'STATE CHUNEIN';
const String _kCityHint = 'Sheher ka naam likhein';
const String _kCityNotFoundError =
    'Yeh sheher list mein nahi mila — neeche diye suggestion mein se chunein.';
const String _kCityAddedToast = 'Sheher add ho gaya';
const String _kLoadError = 'Kuch gadbad ho gayi. Dobara koshish karein.';
const String _kRetry = 'Dobara koshish karein';

/// The tap-to-add suggestion row shows at most this many cities at once —
/// mirrors `_kMaxSuggestionChips` on the qualifications page's certificate
/// suggestions (a low-literacy worker scanning a phone screen, not a full
/// picklist).
const int _kMaxCitySuggestions = 6;
const String _kRelocateLabel = 'Doosre sheher ja sakte hain?';
const String _kAccommodationLabel = 'Rehne ki jagah chahiye?';
const String _kSalaryLabel = 'Mahine ki salary kitni chahte hain?';
const String _kOptionalNote = 'Jo laagu ho, wahi bharein — sab optional hai.';

/// The marker's short internal pages, in walk order — see
/// [TradeFormPreferencesPageState.pageCount].
enum _PrefsPage { languages, documents, shift, jobType, cities, terms }

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
/// `trade_form_models.dart`'s doc on the deliberate duplication) into short
/// INTERNAL pages, walked via [goToNextPage]/[goToPreviousPage] — see
/// this class' own doc for why the pagination lives entirely inside this
/// widget rather than growing `TradeFormCubit.flatSteps`. Every field stays
/// optional; this is a scroll-length change, not a scope cut.
///
/// Painted with the Master UI Kit: closed-set lists are kit option cards
/// (multi-select → [MultiSelectQuestionCard], single-select →
/// [SingleSelectQuestionCard]), the state picker is [OnboardingSelectField],
/// and the two yes/no preferences are kit switch rows. Every label and option
/// still comes from the server's options response (or, for salary, the
/// existing [_kSalaryBands]).
class TradeFormPreferencesPage extends StatefulWidget {
  const TradeFormPreferencesPage({
    super.key,
    required this.loadOptions,
    required this.enabled,
    required this.onSave,
    this.initialPreferences,
    this.onPageChanged,
    this.knownFacts = const <WorkerFact>{},
  });

  /// Facts the worker already gave in the chat (`TradeFormState.knownFacts`).
  /// "Ask once, skip if known": the shift and cities pages are dropped, and the
  /// salary question hidden, for a fact recorded here. A skipped field is never
  /// touched, so the save leaves the chat's stored answer alone.
  final Set<WorkerFact> knownFacts;

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
  ///
  /// Six pages at most; fewer when the chat already recorded the shift or the
  /// preferred cities (see [TradeFormPreferencesPage.knownFacts]).
  int get pageCount => _pages.length;

  late final List<_PrefsPage> _pages = <_PrefsPage>[
    for (final _PrefsPage page in _PrefsPage.values)
      if (!_isKnown(page)) page,
  ];

  bool _isKnown(_PrefsPage page) => switch (page) {
        _PrefsPage.shift => widget.knownFacts.contains(WorkerFact.shift),
        _PrefsPage.cities =>
          widget.knownFacts.contains(WorkerFact.preferredCities),
        _ => false,
      };

  bool get _salaryKnown => widget.knownFacts.contains(WorkerFact.salary);

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
      setState(() => _loadError = _kLoadError);
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
  /// closed-set cards/toggles/a resolved-city picker. (The one free-typed
  /// field that COULD fail, the education year, left with the education
  /// pages — see `pageCount`'s doc.) Checked by `_WizardScaffoldState` before
  /// [goToNextPage]/[save] for every marker, so this stays a real method
  /// rather than being dropped from the shared interface.
  String? currentPageError() => null;

  /// What the wizard's listen button reads on the CURRENT internal page: that
  /// page's visible question heading(s) — app copy only, never a value the
  /// worker picked or typed.
  String currentPageSpeech() => switch (_pages[_page]) {
        _PrefsPage.languages => '$_kLangLabel\n$_kOptionalNote',
        _PrefsPage.documents => '$_kDocLabel\n$_kOptionalNote',
        _PrefsPage.shift => _kShiftLabel,
        _PrefsPage.jobType => _kJobTypeLabel,
        _PrefsPage.cities => '$_kCitiesLabel\n$_kCitiesSubtitle',
        _PrefsPage.terms => _salaryKnown
            ? '$_kRelocateLabel\n$_kAccommodationLabel'
            : '$_kRelocateLabel\n$_kAccommodationLabel\n$_kSalaryLabel',
      };

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
      return TradeFormRetryBlock(
        message: _loadError!,
        retryLabel: _kRetry,
        onRetry: _load,
      );
    }
    if (options == null) return const TradeFormSpinner();
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: _pageContent(options),
      ),
    );
  }

  Widget _pageContent(WorkPrefOptionsDto options) {
    switch (_pages[_page]) {
      case _PrefsPage.languages:
        return _languagesPage(options);
      case _PrefsPage.documents:
        return _documentsPage(options);
      case _PrefsPage.shift:
        return _shiftPage(options);
      case _PrefsPage.jobType:
        return _jobTypePage(options);
      case _PrefsPage.cities:
        return _citiesPage(options);
      case _PrefsPage.terms:
        return _relocateAccommodationSalaryPage();
    }
  }

  Widget _languagesPage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormHeading(title: _kLangLabel, subtitle: _kOptionalNote),
        const SizedBox(height: FormFlowLayout.whyToHintGap),
        const FormHintChip(text: kTradeFormMultiSelectHint),
        const SizedBox(height: FormFlowLayout.hintToOptionsGap),
        // Screen 18 — a clean multi-select list, no subtext.
        _multiCards(options.languages, _prefs.languages, _languageIcon,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                languages: _toggled(_prefs.languages, slug)))),
      ],
    );
  }

  Widget _documentsPage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormHeading(title: _kDocLabel, subtitle: _kOptionalNote),
        const SizedBox(height: FormFlowLayout.whyToHintGap),
        const FormHintChip(text: kTradeFormMultiSelectHint),
        const SizedBox(height: FormFlowLayout.hintToOptionsGap),
        _multiCards(options.documentsReady, _prefs.documentsReady,
            documentOptionIcon,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                documentsReady: _toggled(_prefs.documentsReady, slug)))),
      ],
    );
  }

  Widget _shiftPage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormHeading(title: _kShiftLabel),
        const SizedBox(height: FormFlowLayout.introToOptionsGap),
        _singleCards(options.shift, _prefs.shift, shiftOptionIcon,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                shift: _prefs.shift == slug ? null : slug))),
      ],
    );
  }

  Widget _jobTypePage(WorkPrefOptionsDto options) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormHeading(title: _kJobTypeLabel),
        const SizedBox(height: FormFlowLayout.introToOptionsGap),
        _singleCards(options.jobType, _prefs.jobType, jobTypeOptionIcon,
            (String slug) => setState(() => _prefs = _prefs.copyWith(
                jobType: _prefs.jobType == slug ? null : slug))),
      ],
    );
  }

  /// Opens the kit's searchable state sheet over the server's own state
  /// catalogue — the same pick-then-clear-the-city behaviour the old dropdown
  /// field had (#1429).
  Future<void> _pickState(WorkPrefOptionsDto options) async {
    final String? state = await showOnboardingPicker(
      context,
      title: _kStateLabel,
      options: options.states,
      selected: _cityState,
    );
    if (state == null || !mounted) return;
    setState(() {
      _cityState = state;
      _city.clear();
      _cityError = null;
    });
  }

  Widget _citiesPage(WorkPrefOptionsDto options) {
    final bool atCityCap =
        _prefs.preferredCities.length >= kTradeFormMaxPreferredCities;
    final List<CityOptionDto> suggestions = _matchingCities(options);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormHeading(
          title: _kCitiesLabel,
          subtitle: _kCitiesSubtitle,
        ),
        const SizedBox(height: FormFlowLayout.introToOptionsGap),
        // The add row itself IS this section's "add another" affordance —
        // there's no per-city card to hide, so the row disappears at the
        // cap, same convention as `kTradeFormMaxCertificates`/
        // `kTradeFormMaxEducations`'s add button.
        if (!atCityCap) ...<Widget>[
          // State-then-city cascade (#1429): the state list picks which
          // state's cities the search below offers — State ALWAYS precedes
          // Sheher. No "+" add button, a worker cannot enter a custom city
          // (the server's gazetteer is closed, #1406/#1410), so the ONLY way
          // to add one is picking a suggestion chip below (or hitting the
          // keyboard's "Done", which resolves the same exact-match check a
          // "+" button would have).
          const TradeFormFieldLabel(_kStateLabel),
          OnboardingSelectField(
            value: _cityState ?? '',
            hint: _kPickStateLabel,
            semanticLabel: _kStateLabel,
            onTap: () => _pickState(options),
          ),
          if (_cityState != null) ...<Widget>[
            const SizedBox(height: 14),
            const TradeFormFieldLabel(_kCityLabel),
            TradeFormTextField(
              controller: _city,
              hint: _kCityHint,
              label: _kCityLabel,
              textInputAction: TextInputAction.done,
              errorText: _cityError,
              onChanged: (String v) => setState(() => _cityError = null),
              onSubmitted: (_) => _submitTypedCity(options),
            ),
            if (suggestions.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              // Quick-pick chips — straight off the server gazetteer for the
              // picked state; never a client-side city list.
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  for (final CityOptionDto c in suggestions)
                    TradeFormPillChip(
                      label: c.value,
                      // A city is a place, not a pack option — the icon
                      // rules have nothing to say about it.
                      leadingIcon: Icons.location_on_outlined,
                      onTap: () => _addResolvedCity(c),
                    ),
                ],
              ),
            ],
          ],
        ],
        if (_prefs.preferredCities.isNotEmpty) ...<Widget>[
          const SizedBox(height: 14),
          // Horizontal `ListView.builder`, not a `Wrap` — a picked-cities row
          // scrolls sideways instead of stacking to a second line, so it
          // reads the same as every other horizontally-scrolling chip row in
          // the app (the job feed's header filters).
          SizedBox(
            height: OnboardingLayout.tapTarget,
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              itemCount: _prefs.preferredCities.length,
              itemBuilder: (BuildContext context, int index) {
                final String c = _prefs.preferredCities[index];
                final bool isLast =
                    index == _prefs.preferredCities.length - 1;
                return Padding(
                  padding: EdgeInsets.only(right: isLast ? 0 : 8),
                  child: TradeFormPillChip(
                    label: c,
                    selected: true,
                    trailingIcon: Icons.close,
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
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        TradeFormSwitchRow(
          label: _kRelocateLabel,
          value: _prefs.willingToRelocate,
          onChanged: (bool v) =>
              setState(() => _prefs = _prefs.copyWith(willingToRelocate: v)),
        ),
        const SizedBox(height: 10),
        TradeFormSwitchRow(
          label: _kAccommodationLabel,
          value: _prefs.accommodationNeeded,
          onChanged: (bool v) =>
              setState(() => _prefs = _prefs.copyWith(accommodationNeeded: v)),
        ),
        // The chat already asked "kitna vetan chahte hain" — not again here.
        if (!_salaryKnown) ...<Widget>[
          const SizedBox(height: 24),
          const TradeFormHeading(title: _kSalaryLabel),
          const SizedBox(height: FormFlowLayout.introToOptionsGap),
          for (final MapEntry<int, String> e in _kSalaryBands.entries)
            SingleSelectQuestionCard(
              title: e.value,
              leadingIcon: tradeFormOptionIcon(
                optionKey: '${e.key}',
                label: e.value,
                fallback: Icons.currency_rupee_rounded,
              ),
              isSelected: _prefs.salaryExpectedMax == e.key,
              onTap: () => setState(() => _prefs = _prefs.copyWith(
                  salaryExpectedMax:
                      _prefs.salaryExpectedMax == e.key ? null : e.key)),
              variant: OnboardingVariant.formFlow,
            ),
        ],
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
        backgroundColor: OnboardingColors.successGreen,
        content: Text(
          _kCityAddedToast,
          style: OnboardingTypography.inter(
            size: 13,
            weight: FontWeight.w500,
            color: OnboardingColors.textOnBlue,
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: messenger.hideCurrentMaterialBanner,
            child: Text(
              'Theek hai',
              style: OnboardingTypography.inter(
                size: 14,
                weight: FontWeight.w700,
                color: OnboardingColors.textOnBlue,
              ),
            ),
          ),
        ],
      ),
    );
    Future<void>.delayed(const Duration(seconds: 2), () {
      if (mounted) messenger.hideCurrentMaterialBanner();
    });
  }

  /// A language card: the shared option rules, else the list's own icon — see
  /// [tradeFormOptionIcon].
  static IconData _languageIcon(String optionKey, String label) =>
      tradeFormOptionIcon(
        optionKey: optionKey,
        label: label,
        fallback: Icons.translate_rounded,
      );

  /// [iconFor] resolves each option's tile glyph from its slug and label. The
  /// documents / shift / job-type lists use the SAME resolvers as the
  /// finishing form (`option_icons.dart`), so an option draws one glyph in
  /// both walks.
  Widget _multiCards(Map<String, String> labels, Set<String> selected,
      _OptionIcon iconFor, void Function(String) onTap) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final MapEntry<String, String> e in labels.entries)
          MultiSelectQuestionCard(
            title: e.value,
            leadingIcon: iconFor(e.key, e.value),
            isSelected: selected.contains(e.key),
            onTap: () => onTap(e.key),
            variant: OnboardingVariant.formFlow,
          ),
      ],
    );
  }

  /// A single-select list that — exactly like the chips it replaced — clears
  /// the pick when the selected card is tapped again (every field here is
  /// optional).
  Widget _singleCards(Map<String, String> labels, String? selected,
      _OptionIcon iconFor, void Function(String) onTap) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final MapEntry<String, String> e in labels.entries)
          SingleSelectQuestionCard(
            title: e.value,
            leadingIcon: iconFor(e.key, e.value),
            isSelected: selected == e.key,
            onTap: () => onTap(e.key),
            variant: OnboardingVariant.formFlow,
          ),
      ],
    );
  }
}
