import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart' show QualificationOptionsDto;
import '../../../../core/util/tap_guard.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/title_case.dart';
import '../../../../core/widgets/onboarding/selection_cards.dart';
import '../../domain/trade_form_models.dart';
import 'trade_form_kit.dart';
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
const String _kFieldLabel = 'Kis subject me kiya';
const String _kFieldHint = 'Jaise: Machinist';
const String _kCouncilLabel = 'Council / board';
const String _kEduYearLabel = 'Kis saal poora hua';
const String _kEduYearHint = 'Jaise: 2018';
const String _kInstituteLabel = 'Institute ka naam';
const String _kInstituteHint = 'Jaise: Govt. ITI, Faridabad';
const String _kRemove = 'Hataayein';
const String _kOptionsLoadError = 'Kuch gadbad ho gayi. Dobara koshish karein.';
const String _kRetry = 'Dobara koshish karein';
// Only one open form at a time: tapping "add" with the current card still
// incomplete shows one of these instead of opening a new card.
const String _kAddCertBlockedError =
    'Pehle ye form bharein — tabhi naya certificate jod sakte hain.';
const String _kAddEduBlockedError =
    'Pehle ye form bharein — tabhi nayi entry jod sakte hain.';

const int _kYearMin = 1950;
const String _kYearFutureError = 'Yeh saal abhi aaya nahi — sahi saal likhein';
const String _kYearInvalidError = 'Sahi saal likhein';

// A row the worker actually USED must be COMPLETE, not merely non-empty in one
// field. A certificate with a name but no issuer or year printed an unusable
// credential line, and an education with a year but no institute/board did the
// same. "Used" is the model's own `isBlank`: a row with nothing entered is
// dropped before the write and never blocked, so a worker with none is never
// forced to invent one.
const String _kCertNameRequiredError = 'Certificate ka naam likhein.';
const String _kIssuerRequiredError = 'Kisne diya — likhein.';
const String _kCertYearRequiredError = 'Kis saal mila — saal likhein.';
const String _kEduCredentialRequiredError = 'ITI ya Diploma — chunein.';
const String _kEduFieldRequiredError = 'Kis subject me kiya — likhein.';
const String _kEduCouncilRequiredError = 'Council ya board chunein.';
const String _kEduYearRequiredError = 'Kis saal poora hua — saal likhein.';
const String _kEduInstituteRequiredError = 'Institute ka naam likhein.';

/// `EDUCATION_QUALIFICATIONS` slugs (`worker-preferences.vocabulary.ts`) that
/// carry a real trade/stream — ITI, Diploma and Graduate name a specific
/// trade or subject, and 12th pass carries a stream (Science/Commerce/Arts).
/// `below_10`/`class_10` do not: there is no "subject" to a 10th-or-below
/// schooling, so the field has nothing honest to ask for and stays hidden.
const Set<String> _kFieldVisibleCredentials = <String>{
  'iti',
  'diploma',
  'graduate',
  'class_12',
};

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
/// #1384 item 2 — the two sections are separate INTERNAL pages rather than
/// stacked on one scroll. Education is ONE page: each entry is a single card
/// holding credential, subject, board, year and institute together, with the
/// detail fields revealed just below the selected credential.
///
/// TRI-STATE, NOT "always send both lists" (see `trade_form_models.dart`'s
/// `TradeFormQualifications` doc): this widget's only job is to track,
/// per section, whether the worker touched it at all — [save] hands the
/// cubit a [TradeFormQualifications] with `certificatesTouched`/
/// `educationsTouched` set the moment a row is added, edited, or removed,
/// and left false if the worker never interacts with that half of the page.
///
/// Painted with the Master UI Kit: white kit cards per entry, kit inputs, and
/// the closed-set credential/council lists as [SingleSelectQuestionCard]s.
class TradeFormQualificationsPage extends StatefulWidget {
  const TradeFormQualificationsPage({
    super.key,
    required this.suggestedCertificates,
    required this.loadOptions,
    required this.enabled,
    required this.onSave,
    this.initialQualifications,
    this.tierScope = TradeFormTierScope.unscoped,
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

  /// Which of this page's fields the chosen tier ASKS FOR (#1698/#1710).
  ///
  /// ASK-ONLY. `certificates` hidden drops the certificates sub-page; the
  /// stored certificates are untouched, because this page's PUT is TRI-STATE
  /// and [TradeFormQualifications.toJson] omits a key whose section was never
  /// touched — and a section that is never drawn is never touched.
  ///
  /// `trainings` is accepted in the scope and ignored here: this page has no
  /// trainings section to hide, and the PUT leaves an absent key alone.
  final TradeFormTierScope tierScope;

  /// #1384 item 2 — see `TradeFormPreferencesPage.onPageChanged`'s doc; the
  /// same contract, off [pageCount] (certificates, then education).
  final void Function(int page, int pageCount)? onPageChanged;

  @override
  State<TradeFormQualificationsPage> createState() =>
      TradeFormQualificationsPageState();
}

class TradeFormQualificationsPageState
    extends State<TradeFormQualificationsPage> {
  /// Page 0: certificates · 1: education (all fields in one card).
  ///
  /// Education used to be split into 3 internal pages (credential+subject /
  /// council / kis saal poora hua+institute) — a worker facing 5 questions at
  /// once was a wall, but the council-only page confused (a whole screen for
  /// one board question). Now one education page holds every field: the
  /// credential selector on top, and just below the selected credential the
  /// board, subject, year and institute — so tapping a credential reveals the
  /// rest of its form inline.
  ///
  /// The sub-pages this visit actually asks, in walk order — the certificates
  /// page is dropped when this tier does not ask for it (#1698).
  ///
  /// A LIST, NOT A COUNT (#1710). The page used to switch on a raw index with
  /// `0` hard-coded as "certificates", which cannot express "this page is not
  /// asked": dropping the first page would have silently renumbered every
  /// other one.
  List<_QualsPage> get _pages => <_QualsPage>[
        if (!widget.tierScope.hides(kTierFieldCertificates))
          _QualsPage.certificates,
        _QualsPage.education,
      ];

  int get pageCount => _pages.length;

  /// #1474 — one guard per add button. A worker who taps twice because the new
  /// card appended BELOW the fold got two identical cards; the second tap is
  /// now dropped. Held in State on purpose: a guard built in `build()` would
  /// forget every tap it ever saw.
  final TapGuard _addCertGuard = TapGuard();
  final TapGuard _addEduGuard = TapGuard();

  QualificationOptionsDto? _options;
  String? _optionsLoadError;

  late List<TradeFormCertificateEntry> _certificates =
      List<TradeFormCertificateEntry>.of(
          widget.initialQualifications?.certificates ??
              const <TradeFormCertificateEntry>[]);

  /// A STABLE id per certificate card, parallel to [_certificates].
  ///
  /// The cards used to be keyed by POSITION. Removing card 0 of two shifted
  /// the survivor onto key 0, so Flutter matched it to the DELETED card's
  /// element and kept that element's controllers: the worker deleted
  /// "FIRST-CERT" and watched it stay on screen while "SECOND-CERT" vanished
  /// — and the surviving entry then saved under the wrong text. A key that is
  /// tied to the entry rather than to its index cannot do that: the removed
  /// card's element is disposed and every survivor keeps its own state.
  late List<int> _certIds =
      List<int>.generate(_certificates.length, (int i) => i);
  late int _nextCertId = _certificates.length;
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
  /// per-row child widget — a row's typed text must survive rebuilds while the
  /// worker walks. Keeping the controllers in this State (which stays mounted
  /// for the marker's whole internal walk) is the same fix
  /// `TradeFormPreferencesPageState` already uses for its own (non-repeated)
  /// year/institute fields.
  /// SEEDED IN [initState], not by a `late final` initialiser. These four are
  /// derived from [_educations], and a lazy initialiser reads it whenever it
  /// first happens to be touched — which for a list only some sub-pages render
  /// can be INSIDE `_removeEducation`, after that method has already replaced
  /// [_educations] with the shortened list. The list would then seed itself
  /// one element short and the very next `removeAt` would throw a RangeError.
  /// Building them up front removes the ordering hazard entirely.
  late final List<TextEditingController> _eduFieldControllers;
  late final List<TextEditingController> _eduYearControllers;
  late final List<TextEditingController> _eduInstituteControllers;
  late final List<String?> _eduYearErrors;

  int _page = 0;
  bool get isFirstPage => _page <= 0;
  bool get isLastPage => _page >= pageCount - 1;

  @override
  void initState() {
    super.initState();
    _eduFieldControllers = <TextEditingController>[
      for (final TradeFormEducationEntry e in _educations)
        TextEditingController(text: e.field ?? ''),
    ];
    _eduYearControllers = <TextEditingController>[
      for (final TradeFormEducationEntry e in _educations)
        TextEditingController(text: e.year?.toString() ?? ''),
    ];
    _eduInstituteControllers = <TextEditingController>[
      for (final TradeFormEducationEntry e in _educations)
        TextEditingController(text: e.institute ?? ''),
    ];
    _eduYearErrors = <String?>[
      for (final TextEditingController c in _eduYearControllers)
        _yearErrorText(c.text),
    ];
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
  /// through).
  ///
  /// EVERY FIELD ON A USED ROW: a row the worker started must be complete
  /// before the wizard moves past the page (a certificate row needs its three
  /// fields; an education row needs credential, subject where it applies,
  /// council, year and institute — all on its single page). A wholly-blank row
  /// is skipped — it is dropped before the write, so a worker with no
  /// certificates or education is never blocked. A year is also range-checked
  /// from the MODEL, not only from the inline field callback: a value loaded
  /// from saved data never fires that callback, and an out-of-range year would
  /// otherwise slip through the gate it used to.
  String? currentPageError() {
    final List<_QualsPage> pages = _pages;
    final _QualsPage page =
        _page >= 0 && _page < pages.length ? pages[_page] : pages.last;
    if (page == _QualsPage.certificates) return _certificatesError();
    return _educationError();
  }

  /// Page 0: every used certificate needs a name, an issuer and a valid year.
  String? _certificatesError() {
    for (int i = 0; i < _certificates.length; i++) {
      final TradeFormCertificateEntry c = _certificates[i];
      if (c.isBlank) continue;
      if (c.name.trim().isEmpty) return _kCertNameRequiredError;
      if (c.issuer == null || c.issuer!.trim().isEmpty) {
        return _kIssuerRequiredError;
      }
      if (_certYearErrorIndices.contains(i)) return _kBlockedAdvanceMessage;
      final int? year = c.year;
      if (year == null) return _kCertYearRequiredError;
      if (year < _kYearMin || year > DateTime.now().year) {
        return _kBlockedAdvanceMessage;
      }
    }
    return null;
  }

  /// The single education page owns every field: each used row needs its
  /// credential, its subject where the credential names one
  /// (`_kFieldVisibleCredentials`), its council, and its year+institute —
  /// matching what the unified card renders.
  String? _educationError() {
    for (int i = 0; i < _educations.length; i++) {
      final TradeFormEducationEntry e = _educations[i];
      if (e.isBlank) continue;
      if (e.credential == null) return _kEduCredentialRequiredError;
      if (_kFieldVisibleCredentials.contains(e.credential) &&
          (e.field == null || e.field!.trim().isEmpty)) {
        return _kEduFieldRequiredError;
      }
      if (e.council == null) return _kEduCouncilRequiredError;
      if (_eduYearErrors[i] != null) return _kBlockedAdvanceMessage;
      final int? year = e.year;
      if (year == null) return _kEduYearRequiredError;
      if (year < _kYearMin || year > DateTime.now().year) {
        return _kBlockedAdvanceMessage;
      }
      if (e.institute == null || e.institute!.trim().isEmpty) {
        return _kEduInstituteRequiredError;
      }
    }
    return null;
  }

  /// True when the education row at [index] still needs work before another
  /// entry may be opened — blank counts as incomplete (a card opened but left
  /// empty is the "not filled" case). Mirrors [_educationError] for one row,
  /// including the inline year error that never reached the model.
  bool _educationRowIncomplete(int index) {
    final TradeFormEducationEntry e = _educations[index];
    if (e.isBlank) return true;
    if (e.credential == null) return true;
    if (_kFieldVisibleCredentials.contains(e.credential) &&
        (e.field == null || e.field!.trim().isEmpty)) {
      return true;
    }
    if (e.council == null) return true;
    if (_eduYearErrors[index] != null) return true;
    final int? year = e.year;
    if (year == null || year < _kYearMin || year > DateTime.now().year) {
      return true;
    }
    if (e.institute == null || e.institute!.trim().isEmpty) return true;
    return false;
  }

  /// True when the certificate at [index] still needs work before another may
  /// be opened — blank counts as incomplete. Mirrors [_certificatesError] for
  /// one row, including the inline year error.
  bool _certificateIncomplete(int index) {
    final TradeFormCertificateEntry c = _certificates[index];
    if (c.isBlank) return true;
    if (c.name.trim().isEmpty) return true;
    if (c.issuer == null || c.issuer!.trim().isEmpty) return true;
    if (_certYearErrorIndices.contains(index)) return true;
    final int? year = c.year;
    if (year == null || year < _kYearMin || year > DateTime.now().year) {
      return true;
    }
    return false;
  }

  /// What the wizard's listen button reads on the CURRENT internal page: its
  /// heading (and the note under it where one shows) — app copy only, never a
  /// certificate, institute or year the worker typed.
  String currentPageSpeech() {
    final List<_QualsPage> pages = _pages;
    final _QualsPage page =
        _page >= 0 && _page < pages.length ? pages[_page] : pages.last;
    if (page == _QualsPage.certificates) {
      return '$_kCertTitle\n$_kCertSubtitle';
    }
    return '$_kEduTitle\n$_kEduSubtitle';
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

  void _addCertificate(BuildContext context) {
    if (_certificates.length >= kTradeFormMaxCertificates) return;
    // Only ONE open form at a time: a new card holds a "Certificate ka naam"
    // input, and opening another over an unfinished card leaves two blanks.
    if (_certificates.isNotEmpty &&
        _certificateIncomplete(_certificates.length - 1)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text(_kAddCertBlockedError)),
      );
      return;
    }
    setState(() {
      _certificates = <TradeFormCertificateEntry>[
        ..._certificates,
        const TradeFormCertificateEntry(name: ''),
      ];
      _certIds = <int>[..._certIds, _nextCertId++];
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
      _certIds = List<int>.of(_certIds)..removeAt(index);
      _certificatesTouched = true;
      // Every surviving card keeps its own element (it keeps its id), so the
      // year-validity each one reported is still ITS OWN — but the indices
      // those were recorded under have shifted, so drop them and let the
      // cards re-report rather than block the wizard on a stale index.
      _certYearErrorIndices.clear();
    });
  }

  // --- Education ---------------------------------------------------------

  void _addEducation(BuildContext context) {
    if (_educations.length >= kTradeFormMaxEducations) return;
    // Same one-open-form rule as certificates: finish the current entry
    // (credential, subject, board, year, institute) before opening the next.
    if (_educations.isNotEmpty &&
        _educationRowIncomplete(_educations.length - 1)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text(_kAddEduBlockedError)),
      );
      return;
    }
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

  /// A credential tap for row [index]. Toggles [slug] exactly like every
  /// other single-select list here — but a credential switching AWAY from
  /// ITI/Diploma/Graduate/12th pass also hides (see [_kFieldVisibleCredentials])
  /// and clears the trade/subject field, so a stale subject typed under the
  /// PREVIOUS credential never rides along on a save under a credential that
  /// has no subject to name.
  void _onCredentialSelected(
      int index, TradeFormEducationEntry e, String slug) {
    final String? nextCredential = e.credential == slug ? null : slug;
    if (!_kFieldVisibleCredentials.contains(nextCredential)) {
      _eduFieldControllers[index].clear();
      _updateEducation(
          index, e.copyWith(credential: nextCredential, field: null));
      return;
    }
    _updateEducation(index, e.copyWith(credential: nextCredential));
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
      // The education page always exists, so removal cannot strand the worker
      // — but clamp anyway before the frame that would paint past the end.
      final int maxPage = pageCount - 1; // recomputed off the NEW _educations
      if (_page > maxPage) _page = maxPage;
    });
    widget.onPageChanged?.call(_page, pageCount);
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: _pageContent(context),
      ),
    );
  }

  Widget _pageContent(BuildContext context) {
    final List<_QualsPage> pages = _pages;
    final _QualsPage page =
        _page >= 0 && _page < pages.length ? pages[_page] : pages.last;
    switch (page) {
      case _QualsPage.certificates:
        return _certificatesPage(context);
      case _QualsPage.education:
        return _educationPage(
          title: _kEduTitle,
          subtitle: _kEduSubtitle,
        );
    }
  }

  Widget _certificatesPage(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormHeading(title: _kCertTitle, subtitle: _kCertSubtitle),
        const SizedBox(height: FormFlowLayout.introToOptionsGap),
        for (int i = 0; i < _certificates.length; i++) ...<Widget>[
          _CertificateCard(
            key: ValueKey<int>(_certIds[i]),
            entry: _certificates[i],
            header: _certificateHeader(i),
            suggestions: widget.suggestedCertificates,
            onChanged: (TradeFormCertificateEntry e) =>
                _updateCertificate(i, e),
            onRemove: () => _removeCertificate(i),
            onValidityChanged: (bool hasError) =>
                _onCertYearValidity(i, hasError),
          ),
          const SizedBox(height: 12),
        ],
        if (_certificates.length < kTradeFormMaxCertificates)
          TradeFormSecondaryButton(
            label: _kAddCertificate,
            icon: Icons.add,
            onPressed: _addCertGuard.wrap(() => _addCertificate(context)),
          ),
      ],
    );
  }

  /// The education marker's single internal page — [title]/[subtitle] (the
  /// heading + "up to 4 entries" note). The heading rides here (#1469) so no
  /// state of this page is ever a contextless spinner while options load.
  Widget _educationPage({
    String? title,
    String? subtitle,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (title != null) ...<Widget>[
          TradeFormHeading(title: title, subtitle: subtitle),
          const SizedBox(height: FormFlowLayout.introToOptionsGap),
        ],
        _educationSection(context),
      ],
    );
  }

  Widget _educationSection(BuildContext context) {
    if (_optionsLoadError != null) {
      return TradeFormRetryBlock(
        message: _optionsLoadError!,
        retryLabel: _kRetry,
        onRetry: _loadOptions,
      );
    }
    final QualificationOptionsDto? options = _options;
    if (options == null) return const TradeFormSpinner();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int i = 0; i < _educations.length; i++) ...<Widget>[
          TradeFormCard(
            onRemove: () => _removeEducation(i),
            removeTooltip: _kRemove,
            child: _educationRow(i, options),
          ),
          const SizedBox(height: 12),
        ],
        if (_educations.length < kTradeFormMaxEducations)
          TradeFormSecondaryButton(
            label: _kAddEducation,
            icon: Icons.add,
            onPressed: _addEduGuard.wrap(() => _addEducation(context)),
          ),
      ],
    );
  }

  /// One education entry, all its fields in ONE card: the credential selector
  /// on top, and just below the selected credential the subject (where the
  /// credential names one), board, year and institute. A fresh entry shows
  /// only the credential list — tapping one reveals the rest inline — so the
  /// board no longer owns a confusing screen of its own. Saved partial rows
  /// keep their detail fields visible even with no credential, so stored data
  /// is never hidden.
  Widget _educationRow(int i, QualificationOptionsDto options) {
    final TradeFormEducationEntry e = _educations[i];
    final bool showField = _kFieldVisibleCredentials.contains(e.credential);
    final bool hasDetail = (e.field ?? '').trim().isNotEmpty ||
        e.council != null ||
        e.year != null ||
        (e.institute ?? '').trim().isNotEmpty ||
        _eduYearControllers[i].text.trim().isNotEmpty;
    final bool showDetails = e.credential != null || hasDetail;
    final String? header =
        _educations.length > 1 ? _educationEntryHeader(i, options) : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (header != null) ...<Widget>[
          _EntryHeader(text: header),
          const SizedBox(height: 8),
        ],
        const TradeFormFieldLabel(_kCredentialLabel),
        _eduSingleCards(
          options.educationCredential,
          e.credential,
          Icons.school_outlined,
          (String slug) => _onCredentialSelected(i, e, slug),
        ),
        if (showDetails) ...<Widget>[
          if (showField) ...<Widget>[
            const SizedBox(height: 4),
            const TradeFormFieldLabel(_kFieldLabel),
            TradeFormTextField(
              controller: _eduFieldControllers[i],
              hint: _kFieldHint,
              label: _kFieldLabel,
              maxLength: 80,
              onChanged: (String v) => _updateEducation(
                  i, e.copyWith(field: _titleCaseOrNull(v))),
            ),
          ],
          const SizedBox(height: 4),
          const TradeFormFieldLabel(_kCouncilLabel),
          _eduSingleCards(
            options.educationCouncil,
            e.council,
            Icons.account_balance_outlined,
            (String slug) => _updateEducation(
                i, e.copyWith(council: e.council == slug ? null : slug)),
          ),
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kEduYearLabel),
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
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kInstituteLabel),
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
      ],
    );
  }

  /// Which certificate a stacked card belongs to ("Certificate 1 — CNC").
  ///
  /// Same duplicate-card shape as education: one card per certificate entry,
  /// so two entries read as the same "Certificate ka naam" card twice. Null
  /// for a lone entry, so the common single-certificate walk gains no noise.
  String? _certificateHeader(int index) {
    if (_certificates.length <= 1) return null;
    final String name = _certificates[index].name.trim();
    final String base = 'Certificate ${index + 1}';
    return name.isEmpty ? base : '$base — $name';
  }

  /// Which education entry a repeated card belongs to.
  ///
  /// Two entries read as the same unified card twice, so each card names its
  /// entry instead: "Entry 1 — ITI, Machinist". Falls back to "Entry N" when
  /// the credential has no readable detail yet. Null for a lone entry, so the
  /// common single-entry walk gains no noise.
  String? _educationEntryHeader(int index, QualificationOptionsDto options) {
    final TradeFormEducationEntry e = _educations[index];
    final String? rawCredential =
        e.credential == null ? null : options.educationCredential[e.credential];
    final String credentialLabel = (rawCredential ?? e.credential ?? '').trim();
    final String field = (e.field ?? '').trim();
    String? detail;
    if (credentialLabel.isNotEmpty && field.isNotEmpty) {
      detail = '$credentialLabel, $field';
    } else if (credentialLabel.isNotEmpty) {
      detail = credentialLabel;
    } else if (field.isNotEmpty) {
      detail = field;
    }
    if (_educations.length > 1) {
      final String base = 'Entry ${index + 1}';
      return detail == null ? base : '$base — $detail';
    }
    return detail;
  }

  /// A single-select list that clears the pick when the selected card is
  /// tapped again — the same toggle the chips it replaced had. [fallback] is
  /// the list's own icon for an option the shared icon rules do not recognise
  /// — see [tradeFormOptionIcon].
  Widget _eduSingleCards(Map<String, String> labels, String? selected,
      IconData fallback, void Function(String) onTap) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final MapEntry<String, String> entry in labels.entries)
          SingleSelectQuestionCard(
            title: entry.value,
            leadingIcon: tradeFormOptionIcon(
              optionKey: entry.key,
              label: entry.value,
              fallback: fallback,
            ),
            isSelected: selected == entry.key,
            onTap: () => onTap(entry.key),
            variant: OnboardingVariant.formFlow,
          ),
      ],
    );
  }
}

/// The qualifications marker's own sub-pages, in walk order. Named rather
/// than numbered so a page that this tier does not ask for can be dropped
/// without renumbering the rest (#1710).
enum _QualsPage { certificates, education }

/// The per-entry header that tells the worker WHICH entry a repeated card
/// belongs to ("Entry 1 — ITI, Machinist"). Drawn inside the card, above its
/// fields, in the kit's navy — a label, never a second question.
class _EntryHeader extends StatelessWidget {
  const _EntryHeader({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: OnboardingTypography.inter(
        size: 13,
        weight: FontWeight.w700,
        color: OnboardingColors.shiftBlue,
      ),
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

/// [_trimOrNull], plus [titleCaseName] — for the institute and trade/subject
/// fields (both short proper-noun-like labels, e.g. "electric" -> "Electric").
/// Certificate name/issuer stays on [_trimOrNull] verbatim, along with every
/// genuine free-text description elsewhere in this walk: title-casing is
/// never applied to a description a worker wrote in their own words.
String? _titleCaseOrNull(String v) {
  final String? trimmed = _trimOrNull(v);
  return trimmed == null ? null : titleCaseName(trimmed);
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
    this.header,
    this.onValidityChanged,
  });

  final TradeFormCertificateEntry entry;
  final String? header;
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
    return TradeFormCard(
      onRemove: widget.onRemove,
      removeTooltip: _kRemove,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (widget.header != null) ...<Widget>[
            _EntryHeader(text: widget.header!),
            const SizedBox(height: 8),
          ],
          const TradeFormFieldLabel(_kCertNameLabel),
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
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final String s in suggestions)
                  TradeFormPillChip(
                    label: s,
                    leadingIcon: tradeFormOptionIcon(
                      optionKey: '',
                      label: s,
                      fallback: Icons.workspace_premium_outlined,
                    ),
                    selected: _name.text.trim() == s,
                    onTap: () => _pickSuggestion(s),
                  ),
              ],
            ),
          ],
          // Issuer and year stack rather than sit side by side: two kit
          // inputs in one row do not fit a 320dp screen at large text.
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kIssuerLabel),
          TradeFormTextField(
            controller: _issuer,
            hint: _kIssuerHint,
            label: _kIssuerLabel,
            maxLength: 120,
            onChanged: (String v) => _push(e.copyWith(issuer: _trimOrNull(v))),
          ),
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kCertYearLabel),
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
    );
  }
}
