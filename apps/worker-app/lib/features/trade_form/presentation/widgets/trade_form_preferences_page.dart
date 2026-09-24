import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart'
    show CityHubDto, CityOptionDto, WorkPrefOptionsDto;
import '../../../../core/session/known_worker_facts_store.dart' show WorkerFact;
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/form_flow_parts.dart';
import '../../../../core/widgets/onboarding/option_icons.dart';
import '../../../../core/widgets/onboarding/selection_cards.dart';
import '../../domain/trade_form_models.dart';
import 'design2_cities_page.dart';
import 'trade_form_kit.dart';

/// The tile glyph for one option card, from its slug and label.
typedef _OptionIcon = IconData Function(String optionKey, String label);

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kLangLabel = 'Aap kaun si bhasha bolte hain?';
const String _kLangSubtitle = 'Zyada se zyada 6 bhasha chun sakte hain.';
const String _kDocLabel = 'Kaun se document taiyaar hain?';
const String _kShiftLabel = 'Shift';
const String _kJobTypeLabel = 'Naukri ka type';
const String _kCitiesLabel = 'Kahan kaam karna chahte hain?';
const String _kCitiesSubtitle =
    'Aap 1 se $kTradeFormMaxPreferredCities sheher chun sakte hain.';
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
/// [SingleSelectQuestionCard]), the preferred-cities picker is the DESIGN2
/// [Design2CitiesPage] (states → hubs → search), and the two yes/no
/// preferences are kit switch rows. Every label and option still comes from
/// the server's options response (or, for salary, the existing
/// [_kSalaryBands]).
class TradeFormPreferencesPage extends StatefulWidget {
  const TradeFormPreferencesPage({
    super.key,
    required this.loadOptions,
    required this.enabled,
    required this.onSave,
    this.initialPreferences,
    this.tierScope = TradeFormTierScope.unscoped,
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

  /// Which of this page's fields the chosen tier ASKS FOR (#1698/#1710).
  ///
  /// ASK-ONLY. A hidden field is not prompted; its stored value is untouched
  /// and goes back unchanged, because [TradeFormPreferences.toJson] sends a
  /// key only when the worker touched it — and a page that never draws a
  /// field can never touch it. Hiding is therefore free of data loss BY
  /// CONSTRUCTION here, not by a rule someone has to remember.
  final TradeFormTierScope tierScope;

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

  /// Whether this internal page is NOT asked — either the chat already
  /// recorded the fact ([TradeFormPreferencesPage.knownFacts]) or the chosen
  /// tier does not ask for it ([TradeFormPreferencesPage.tierScope]). Both are
  /// the same decision to this walk: do not put the question on screen.
  bool _isKnown(_PrefsPage page) => switch (page) {
        _PrefsPage.shift => widget.knownFacts.contains(WorkerFact.shift),
        _PrefsPage.cities =>
          widget.knownFacts.contains(WorkerFact.preferredCities),
        _PrefsPage.documents =>
          widget.tierScope.hides(kTierFieldDocumentsReady),
        _ => false,
      };

  bool get _salaryKnown => widget.knownFacts.contains(WorkerFact.salary);

  WorkPrefOptionsDto? _options;
  String? _loadError;
  late TradeFormPreferences _prefs =
      widget.initialPreferences ?? const TradeFormPreferences();

  /// The DESIGN2 browse box — filters the hub/city cards as the worker types.
  ///
  /// It is the ONLY city text input now. The separate "Koi sheher?" exact-entry
  /// box is gone: it accepted only a full canonical name or alias, so it
  /// answered a worker who typed "Kol" with a red "not in the list" while the
  /// cards below were already showing him Kolhapur and Kolkata. Tapping a card
  /// is the single add path, and it carries the canonical value the server's
  /// `preferred_cities` validator accepts (#1406/#1410).
  final TextEditingController _search = TextEditingController();

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
    _search.dispose();
    super.dispose();
  }

  /// Called by the screen's sticky bottom bar ONLY on this marker's LAST
  /// internal page — see `_WizardScaffoldState`'s routing.
  void save() => widget.onSave(_prefs);

  /// The one page on this marker that CAN still be entered wrong: `languages`
  /// is capped at [kTradeFormMaxLanguages] server-side
  /// (`worker-preferences.dto.ts`), so a seventh tick would 400 the whole
  /// save on the LAST internal page (`terms`) — the exact dead end this guards
  /// against. Checked by `_WizardScaffoldState` before [goToNextPage]/[save].
  String? currentPageError() {
    if (_pages[_page] == _PrefsPage.languages &&
        _prefs.languages.length > kTradeFormMaxLanguages) {
      return _kLangSubtitle;
    }
    return null;
  }

  /// What the wizard's listen button reads on the CURRENT internal page: that
  /// page's visible question heading(s) — app copy only, never a value the
  /// worker picked or typed.
  String currentPageSpeech() => switch (_pages[_page]) {
        _PrefsPage.languages => '$_kLangLabel\n$_kLangSubtitle $_kOptionalNote',
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

  /// Toggles a language, enforcing [kTradeFormMaxLanguages] at the input edge
  /// so a seventh tick can never become a 400 on the `terms` page. Removing an
  /// already-picked language always works; adding past the cap is ignored with
  /// an honest banner naming the limit.
  void _toggleLanguage(String slug) {
    if (_prefs.languages.contains(slug)) {
      setState(() => _prefs = _prefs.copyWith(
          languages: _toggled(_prefs.languages, slug)));
      return;
    }
    if (_prefs.languages.length >= kTradeFormMaxLanguages) {
      _showCapBanner();
      return;
    }
    setState(() => _prefs =
        _prefs.copyWith(languages: _toggled(_prefs.languages, slug)));
  }

  /// The language cap's honest banner, naming the limit — see [_showBanner]
  /// for why it is a top [MaterialBanner] and not a SnackBar.
  void _showCapBanner() =>
      _showBanner(_kLangSubtitle, OnboardingColors.shiftBlue);

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
        const TradeFormHeading(
          title: _kLangLabel,
          subtitle: '$_kLangSubtitle $_kOptionalNote',
        ),
        const SizedBox(height: FormFlowLayout.whyToHintGap),
        const FormHintChip(text: kTradeFormMultiSelectHint),
        const SizedBox(height: FormFlowLayout.hintToOptionsGap),
        // Screen 18 — a clean multi-select list, capped at
        // [kTradeFormMaxLanguages] (see [_toggleLanguage]).
        _multiCards(options.languages, _prefs.languages, _languageIcon,
            _toggleLanguage),
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

  /// Switches the cascading state filter (#1429) — re-tapping the same state
  /// clears it. Clears both text boxes so a stale query never filters a new
  /// state's list.
  void _selectState(String state) {
    setState(() {
      _cityState = _cityState == state ? null : state;
      _search.clear();
    });
  }

  bool _isPicked(String value) {
    final String q = value.toLowerCase();
    return _prefs.preferredCities.any((String c) => c.toLowerCase() == q);
  }

  /// The DESIGN2 cities picker — states, hubs and search (see
  /// [Design2CitiesPage]). Everything is real server data: `city_hubs` when
  /// the backend ships it (#1634), otherwise the selected state's real
  /// `cities` rendered as hub cards without their industrial-area sub-label.
  Widget _citiesPage(WorkPrefOptionsDto options) {
    return Design2CitiesPage(
      maxCities: kTradeFormMaxPreferredCities,
      selectedCities: _prefs.preferredCities,
      states: options.states,
      selectedState: _cityState,
      stateHubs: _stateHubs(options),
      popularHubs: _popularHubs(options),
      searchResults: _searchResults(options),
      searchController: _search,
      // Typing IS the search: the rebuild re-resolves [_searchResults] and the
      // matching cards appear underneath. There is no submit step and no
      // not-found error — a tap on a card is the only way to add a city, which
      // is also the only way to get the canonical value the server accepts.
      onSearchChanged: (String _) => setState(() {}),
      onSelectState: _selectState,
      onToggleHub: _toggleHub,
      onRemoveCity: _removeCity,
    );
  }

  /// The selected state's places: the curated hubs (with their industrial-area
  /// sub-labels) PLUS every real city in the state the hubs do not already
  /// represent.
  ///
  /// The hub catalogue is a curated SUBSET (#1639) — 18 hubs across 11 states
  /// against the 83-city gazetteer — so treating it as the state's whole list
  /// left every hub-less state (Bihar, Odisha, Punjab, …) reading "sheher jald
  /// aa rahe hain" and hid real cities in hub states (Navi Mumbai beside the
  /// Mumbai/Thane hub). Hubs stay first: they are the ones with area labels.
  List<Design2Hub> _stateHubs(WorkPrefOptionsDto options) {
    final String? state = _cityState;
    if (state == null) return const <Design2Hub>[];
    final Set<String> hubValues = <String>{
      for (final CityHubDto h in options.cityHubs)
        if (h.state == state) h.cityValue.toLowerCase(),
    };
    return <Design2Hub>[
      for (final CityHubDto h in options.cityHubs)
        if (h.state == state) h.toView(selected: _isPicked(h.cityValue)),
      for (final CityOptionDto c in options.cities)
        if (c.state == state && !hubValues.contains(c.value.toLowerCase()))
          Design2Hub(
            cityValue: c.value,
            title: c.value,
            selected: _isPicked(c.value),
          ),
    ];
  }

  /// The popular hub row (catalogue only; empty until #1634 ships).
  List<Design2Hub> _popularHubs(WorkPrefOptionsDto options) => <Design2Hub>[
        for (final CityHubDto h in options.cityHubs)
          if (h.popular) h.toView(selected: _isPicked(h.cityValue)),
      ];

  /// Cards matching the browse box — a hub's display/areas/ city, or a city's
  /// value/alias — scoped to [_cityState] when one is picked. Empty while the
  /// box is empty, so the state's hub list stays the default view.
  ///
  /// Searches BOTH lists: hubs carry the area vocabulary ("Chakan"), cities
  /// carry the full gazetteer, and a hub's `city_value` may differ from its
  /// display ("Mumbai / Thane" submits Thane) — so dropping the city list
  /// whenever hubs exist made most canonical cities unfindable.
  List<Design2Hub> _searchResults(WorkPrefOptionsDto options) {
    final String q = _search.text.trim().toLowerCase();
    if (q.isEmpty) return const <Design2Hub>[];
    final String? state = _cityState;
    final List<Design2Hub> out = <Design2Hub>[];
    final Set<String> seen = <String>{};
    for (final CityHubDto h in options.cityHubs) {
      if (state != null && h.state != state) continue;
      final String hay = '${h.display} ${h.areas.join(' ')}'.toLowerCase();
      if (hay.contains(q) || h.cityValue.toLowerCase().contains(q)) {
        if (seen.add(h.cityValue.toLowerCase())) {
          out.add(h.toView(selected: _isPicked(h.cityValue)));
        }
      }
    }
    for (final CityOptionDto c in options.cities) {
      if (state != null && c.state != state) continue;
      if (seen.contains(c.value.toLowerCase())) continue;
      if (c.value.toLowerCase().contains(q) ||
          c.aliases.any((String a) => a.toLowerCase().contains(q))) {
        seen.add(c.value.toLowerCase());
        out.add(Design2Hub(
          cityValue: c.value,
          title: c.value,
          selected: _isPicked(c.value),
        ));
      }
    }
    return out.take(_kMaxCitySuggestions).toList();
  }

  void _toggleHub(String value) {
    if (_isPicked(value)) {
      _removeCity(value);
      return;
    }
    _addCityValue(value);
  }

  void _removeCity(String value) {
    final String q = value.toLowerCase();
    setState(() => _prefs = _prefs.copyWith(
        preferredCities: _prefs.preferredCities
            .where((String c) => c.toLowerCase() != q)
            .toList()));
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

  /// Adds the CANONICAL `value` — never raw typed text and never a hub label —
  /// so `preferred_cities` always sends exactly the spelling the server's own
  /// validator already accepted (`worker-cities.catalogue.ts`'s round-trip
  /// guarantee). A hub tap, a search result and a typed exact match all funnel
  /// through here. At the 5-city cap a new add is refused WITH the honest cap
  /// banner (a silent no-op reads as a broken card); removing always works.
  void _addCityValue(String value) {
    if (value.isEmpty) return;
    if (_isPicked(value)) return;
    if (_prefs.preferredCities.length >= kTradeFormMaxPreferredCities) {
      _showBanner(_kCitiesSubtitle, OnboardingColors.shiftBlue);
      return;
    }
    setState(() {
      _prefs = _prefs.copyWith(
          preferredCities: <String>[..._prefs.preferredCities, value]);
    });
    _showBanner(_kCityAddedToast, OnboardingColors.successGreen);
  }

  /// A MaterialBanner (top), NOT a SnackBar — this screen's sticky bottom bar
  /// owns the bottom edge (see `trade_form_screen.dart`'s `_showBlockedBanner`
  /// doc: a SnackBar here would animate up from the bottom and cover "Aage
  /// badhein").
  void _showBanner(String text, Color color) {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger.clearMaterialBanners();
    messenger.showMaterialBanner(
      MaterialBanner(
        backgroundColor: color,
        content: Text(
          text,
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
