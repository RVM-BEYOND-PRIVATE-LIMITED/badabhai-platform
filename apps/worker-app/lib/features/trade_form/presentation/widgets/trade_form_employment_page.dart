import 'package:flutter/material.dart';

import '../../../../core/api/api_client.dart'
    show CityOptionDto, WorkPrefOptionsDto;

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/tap_guard.dart';
import '../../../../core/widgets/onboarding/onboarding_select_field.dart';
import '../../domain/trade_form_models.dart';
import 'trade_form_kit.dart';
import 'trade_form_text_field.dart';
import 'trade_form_work_dictation.dart';

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kTitle = 'Aapne pehle kahan kaam kiya?';
const String _kSubtitle = 'Zyada se zyada 4 jagah likh sakte hain.';
const String _kAddEmployer = 'Aur ek jagah jodein';
const String _kNameLabel = 'Company ka naam';
const String _kNameHint = 'Jaise: Sandhar Technologies';
const String _kRoleLabel = 'Aapka kaam / role';
// Trade-neutral (#1382 — this pack now scales across 21 trades, not just
// CNC turning). Duplicated verbatim in `finishing/employer_card.dart`; keep
// both in sync if this ever changes.
const String _kRoleHint = 'Jaise: Operator';
const String _kCityLabel = 'Sheher (City)';
const String _kStateLabel = 'State (Rajya)';
// The free-text fields' hints keep their pre-redesign short words.
const String _kCityHint = 'Sheher';
const String _kStateHint = 'State';
const String _kPickStateLabel = 'STATE CHUNEIN';
const String _kPickCityLabel = 'SHEHER CHUNEIN';
const String _kManualEntryLink = 'Khud likhein';
const String _kBackToPickerLink = 'List se chunein';
const String _kRemove = 'Hataayein';

/// TEMPORARY demo data (#1429 — the real state-tagged city gazetteer isn't
/// built yet, KP). Exactly 2 states, 2 cities each, as asked, so this flow
/// can be shown/demoed before the real backend dataset exists. Delete this
/// map (and [_EmployerLocationPicker]'s picker branch) once #1429 lands and
/// wire the real options through instead — [employerCity]/[employerState]
/// stay plain strings on the wire either way, so nothing downstream changes.
// The 2-state demo map that used to live here is GONE (#1429 shipped the real
// dataset): states now come from the server's own state catalogue (all 28
// states + 8 UTs) and cities from the state-tagged gazetteer, both off the
// SAME `GET work-preferences/options` response the preferences page already
// fetches. See `_EmployerLocationPicker` for what happens in the states the
// gazetteer has no city for — which is most of them, and is why the free-text
// path stays.
const String _kStartLabel = 'Kab shuru kiya';
const String _kEndLabel = 'Kab tak';
const String _kStillWorking = 'Abhi yahin kaam kar rahe hain';
const String _kWorkLabel = 'Aap kya kaam karte the?';
// Trade-neutral (#1382). Duplicated verbatim in
// `finishing/employer_card.dart`; keep both in sync if this ever changes.
const String _kWorkHint =
    'Jaise: Naye parts banate the aur quality check karte the';
const String _kNotStated = 'Nahi bataya';
const String _kPickYear = 'Saal chunein';
const String _kPickMonth = 'Mahina chunein';
const int _kWorkDoneMax = 300;
const String _kDateOrderError =
    'Khatam hone ki date shuru hone ke baad honi chahiye.';
// #issue2 — a work history with no start/end is what put "Duration not stated"
// on the résumé. Both are now REQUIRED on a card the worker actually used:
// start always, end unless the card is marked his current job.
const String _kStartRequiredError = 'Kab shuru kiya — saal aur mahina chunein.';
const String _kEndRequiredError =
    'Kab tak kaam kiya — saal aur mahina chunein, ya "Abhi yahin" ON rakhein.';
// #issue2 follow-up — the REQUIRED check was not enough on its own: a
// "9999-12" or a "1900-01" is just as unusable on a résumé as a blank one, and
// a worker can reach either through stale saved data or a hand-built entry.
// These are the "other validations a date should have" bounds, all fail-closed.
const int _kEarliestWorkYear = 1950; // same living-memory floor as qualifications
const String _kDateTooOldError =
    'Itna purana saal sahi nahi lagta — sahi saal chunein.';
const String _kDateFutureError =
    'Aage ke mahine ki taareekh nahi ho sakti — aaj tak ka chunein.';
const String _kDateInvalidError = 'Sahi mahina aur saal chunein.';
// A card the worker actually USED must carry every field the résumé prints,
// except the employer's city/state (a past employer's exact town is frequently
// unknown and is not what the sheet is read for). "Used" is [isBlank]: a card
// with nothing typed is skippable, so a worker with no work history is never
// forced to invent one. The company name/role pair was already required by the
// cubit's `isComplete`; the work description joins them here — an empty one
// printed a blank line under the employer on the sheet.
const String _kNameRequiredError = 'Company ka naam likhein.';
const String _kRoleRequiredError = 'Aapka kaam / role likhein.';
const String _kWorkRequiredError = 'Aap kya kaam karte the — likhein.';

const List<String> _kMonths = <String>[
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// The `type: "employment"` marker screen (#1341) — the repeat-card work
/// history `PUT /workers/me/employment` owns. Same flat single-role shape
/// `features/finishing` sends today; #1341 notes the endpoint now also
/// accepts nested `roles[]`, which is a follow-up, not a blocker (see
/// `trade_form_models.dart`'s doc on this file's deliberate duplication).
///
/// #1384 item 2 — paginated INTERNALLY, one employer per page, rather than
/// all up to [kTradeFormMaxEmployers] cards stacked on one scroll. A worker
/// with zero employers still gets exactly ONE page (title + the "add" outline
/// button, no card) — the same thing this widget rendered before pagination
/// when [_entries] was empty, so skipping employment entirely needs no more
/// taps than it did before.
///
/// Painted with the Master UI Kit (screen 21): kit inputs, State (Rajya)
/// BEFORE Sheher (City), and a kit switch row for "Abhi yahin kaam kar rahe
/// hain". Data sources and validation are unchanged; the work-description mic
/// is #1514's device dictation ([TradeFormWorkDictation]).
class TradeFormEmploymentPage extends StatefulWidget {
  const TradeFormEmploymentPage({
    super.key,
    required this.enabled,
    required this.onSave,
    required this.loadOptions,
    this.initialEntries,
    this.onPageChanged,
    this.onSkip,
  });

  final bool enabled;
  final ValueChanged<List<TradeFormEmploymentEntry>> onSave;

  /// Called INSTEAD of [onSave] when the worker added, edited and removed
  /// nothing and no [initialEntries] were banked: the page then holds only its
  /// blank default, and `PUT /workers/me/employment` REPLACES the whole
  /// history, so saving it would wipe what the worker saved before. Null keeps
  /// the old always-[onSave] behaviour.
  final VoidCallback? onSkip;

  /// The SAME options fetch the preferences marker uses — it carries the
  /// state catalogue and the state-tagged city gazetteer (#1429). Loaded
  /// once here rather than per employer card.
  final Future<WorkPrefOptionsDto> Function() loadOptions;

  /// The cubit's own memory of the last successful save for THIS marker
  /// (#1384 item 1, `TradeFormState.savedEmployment`) — see the doc on
  /// `TradeFormPreferencesPage.initialPreferences` for why a `GlobalKey`
  /// alone cannot carry this across a `goBack()`.
  final List<TradeFormEmploymentEntry>? initialEntries;

  /// #1384 item 2 — see `TradeFormPreferencesPage.onPageChanged`'s doc; the
  /// same contract, reported here off [pageCount] (which — unlike
  /// preferences' fixed count — changes at runtime as employer cards are
  /// added/removed).
  final void Function(int page, int pageCount)? onPageChanged;

  // NO MIC PROPS, DELIBERATELY. The work description's mic is now the device
  // recogniser ([TradeFormWorkDictation]), which needs neither a recorder seam
  // nor the form's session id: nothing is uploaded, so there is no clip to file
  // and no `/voice/*` route to reach. Both props existed solely for the
  // record-and-upload mic they replaced.

  @override
  State<TradeFormEmploymentPage> createState() =>
      TradeFormEmploymentPageState();
}

class TradeFormEmploymentPageState extends State<TradeFormEmploymentPage> {
  late List<TradeFormEmploymentEntry> _entries =
      List<TradeFormEmploymentEntry>.of(
        widget.initialEntries ?? const <TradeFormEmploymentEntry>[],
      );

  /// Set the moment the worker adds, edits or removes an employer card on this
  /// visit. See [TradeFormEmploymentPage.onSkip].
  bool _touched = false;

  /// #1474 — a double-tap used to add two identical employer cards.
  final TapGuard _addGuard = TapGuard();

  int _page = 0;

  /// At least 1 (an empty-employer "add or skip" page) — never 0, so there
  /// is always exactly one page to render even with no employers yet.
  int get pageCount => _entries.isEmpty ? 1 : _entries.length;
  bool get isFirstPage => _page <= 0;
  bool get isLastPage => _page >= pageCount - 1;

  /// The state catalogue + state-tagged city gazetteer (#1429), once loaded.
  /// Null while in flight or if the fetch failed — in BOTH cases the picker
  /// falls back to free text rather than blocking the page, because a work
  /// history the worker cannot type is worse than one without a dropdown.
  WorkPrefOptionsDto? _options;

  @override
  void initState() {
    super.initState();
    _loadOptions();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.onPageChanged?.call(_page, pageCount);
    });
  }

  Future<void> _loadOptions() async {
    try {
      final WorkPrefOptionsDto options = await widget.loadOptions();
      if (!mounted) return;
      setState(() => _options = options);
    } catch (_) {
      // Deliberately silent: the free-text path below is a complete way to
      // enter an employer's location, so a failed options fetch costs the
      // worker a convenience, not the page.
      if (!mounted) return;
      setState(() => _options = null);
    }
  }

  /// Every state/UT the server offers, or empty while the fetch is in flight.
  List<String> get _states => _options?.states ?? const <String>[];

  /// The gazetteer's cities for [state]. EMPTY for most states — the
  /// gazetteer is a closed set of manufacturing hubs (36 cities across 13
  /// states), not a map of India, so a worker whose last employer was
  /// anywhere else types the city instead. See `_EmployerLocationPicker`.
  List<String> _citiesFor(String state) {
    final List<CityOptionDto> all = _options?.cities ?? const <CityOptionDto>[];
    return all
        .where((CityOptionDto c) => c.state == state)
        .map((CityOptionDto c) => c.value)
        .toList();
  }

  /// The cards the worker actually FILLED, as they currently stand — for a
  /// host that persists them itself rather than through the wizard's [save]
  /// (the chat road's experience editor, #issue5). Blank cards are dropped,
  /// mirroring `TradeFormCubit.saveEmploymentAndAdvance`; completeness and the
  /// date rules are the caller's to check via [currentPageError].
  List<TradeFormEmploymentEntry> get nonBlankEntries => _entries
      .where((TradeFormEmploymentEntry e) => !e.isBlank)
      .toList(growable: false);

  /// Called by the screen's sticky bottom bar ONLY on this marker's LAST
  /// internal page — see `_WizardScaffoldState`'s routing.
  void save() {
    final VoidCallback? skip = widget.onSkip;
    if (skip != null && !_touched && widget.initialEntries == null) {
      skip();
      return;
    }
    widget.onSave(_entries);
  }

  /// #issue2 — every card the worker actually USED must carry a start date, and
  /// an end date unless it is marked his current job ("Abhi yahin", carried on
  /// [TradeFormEmploymentEntry.stillWorking]); without this the résumé printed
  /// "Duration not stated". EVERY card is checked, not only [_page]: employers
  /// are added with "Aur ek jagah jodein", which jumps to the new card WITHOUT
  /// passing through the advance button, so a per-page check would leave an
  /// earlier card unvalidated and save it dateless. A BLANK card is not an
  /// answer and is never blocked — the worker can skip work history entirely.
  /// When the offending card is not the one on screen, the page jumps to it so
  /// the worker sees the fields the message is about.
  ///
  /// THE WHOLE CARD, NOT ONLY ITS DATES: an employer with content but no company
  /// name, role or work description is just as unusable on the sheet, and the
  /// city/state pair is the ONLY thing a used card may leave empty. See
  /// [_entryError].
  String? currentPageError() {
    for (int i = 0; i < _entries.length; i++) {
      final TradeFormEmploymentEntry e = _entries[i];
      if (e.isBlank) continue;
      final String? error = _entryError(e);
      if (error != null) {
        if (i != _page) {
          setState(() => _page = i);
          widget.onPageChanged?.call(_page, pageCount);
        }
        return error;
      }
    }
    return null;
  }

  /// One card's blocking message, or null when it is complete. Order is the
  /// field order on the card: company name, role, work description, then the
  /// date rules (see [_dateErrorFor]). `employerCity`/`employerState` are
  /// deliberately not checked — a used card may leave both empty.
  String? _entryError(TradeFormEmploymentEntry e) {
    if (e.employerName.trim().isEmpty) return _kNameRequiredError;
    if (e.roleLabel.trim().isEmpty) return _kRoleRequiredError;
    if (e.workDone == null || e.workDone!.trim().isEmpty) {
      return _kWorkRequiredError;
    }
    return _dateErrorFor(e);
  }

  /// The date rules for one card, in priority order: a start is always
  /// required once a card has content; both dates must be well-formed, within
  /// [_kEarliestWorkYear]…today; an end is required when the card is NOT the
  /// worker's current job; and the end may not fall before the start. See
  /// [currentPageError].
  String? _dateErrorFor(TradeFormEmploymentEntry e) {
    final String? start = _dateFieldError(
      e.startYm,
      requiredMessage: _kStartRequiredError,
    );
    if (start != null) return start;
    if (!e.stillWorking) {
      final String? end = _dateFieldError(
        e.endYm,
        requiredMessage: _kEndRequiredError,
      );
      if (end != null) return end;
      // Start after end — the same rule each picker enforces with a snackbar,
      // restated here for a value that arrived without passing through one.
      if (_compareYearMonth(e.endYm, e.startYm) < 0) return _kDateOrderError;
    }
    return null;
  }

  /// What the wizard's listen button reads on the CURRENT internal page: the
  /// marker's question (with its note on the first page, where both show) —
  /// app copy only, never an employer, role or description the worker typed.
  String currentPageSpeech() =>
      _page == 0 ? '$_kTitle\n$_kSubtitle' : _kTitle;

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

  void _add() {
    if (_entries.length >= kTradeFormMaxEmployers) return;
    setState(() {
      _touched = true;
      _entries = <TradeFormEmploymentEntry>[
        ..._entries,
        const TradeFormEmploymentEntry(employerName: '', roleLabel: ''),
      ];
      _page = _entries.length - 1; // land on the newly-added card
    });
    widget.onPageChanged?.call(_page, pageCount);
  }

  void _update(int index, TradeFormEmploymentEntry entry) {
    final List<TradeFormEmploymentEntry> next =
        List<TradeFormEmploymentEntry>.of(_entries);
    next[index] = entry;
    setState(() {
      _touched = true;
      _entries = next;
    });
  }

  void _remove(int index) {
    final List<TradeFormEmploymentEntry> next =
        List<TradeFormEmploymentEntry>.of(_entries)..removeAt(index);
    setState(() {
      _touched = true;
      _entries = next;
      final int maxPage = pageCount - 1; // recomputed off the NEW _entries
      if (_page > maxPage) _page = maxPage;
    });
    widget.onPageChanged?.call(_page, pageCount);
  }

  @override
  Widget build(BuildContext context) {
    final List<Widget> children = <Widget>[];
    if (_page == 0) {
      children.addAll(<Widget>[
        const TradeFormHeading(title: _kTitle, subtitle: _kSubtitle),
        const SizedBox(height: FormFlowLayout.introToOptionsGap),
      ]);
    }
    if (_entries.isNotEmpty) {
      final int i = _page;
      children.add(
        _EmployerCard(
          key: ValueKey<int>(i),
          entry: _entries[i],
          states: _states,
          citiesFor: _citiesFor,
          onChanged: (TradeFormEmploymentEntry e) => _update(i, e),
          onRemove: () => _remove(i),
        ),
      );
    }
    if (isLastPage && _entries.length < kTradeFormMaxEmployers) {
      if (_entries.isNotEmpty) {
        children.add(const SizedBox(height: 12));
      }
      children.add(
        TradeFormSecondaryButton(
          label: _kAddEmployer,
          icon: Icons.add,
          onPressed: _addGuard.wrap(_add),
        ),
      );
    }
    return IgnorePointer(
      ignoring: !widget.enabled,
      child: Opacity(
        opacity: widget.enabled ? 1 : 0.5,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      ),
    );
  }
}

class _EmployerCard extends StatefulWidget {
  const _EmployerCard({
    super.key,
    required this.entry,
    required this.states,
    required this.citiesFor,
    required this.onChanged,
    required this.onRemove,
  });

  final List<String> states;
  final List<String> Function(String state) citiesFor;

  final TradeFormEmploymentEntry entry;
  final ValueChanged<TradeFormEmploymentEntry> onChanged;
  final VoidCallback onRemove;

  @override
  State<_EmployerCard> createState() => _EmployerCardState();
}

/// Returns -1, 0, or 1 for `a` before, equal, or after `b` in "YYYY-MM" order.
int _compareYearMonth(String? a, String? b) {
  if (a == null || b == null) return 0;
  final List<String> pa = a.split('-');
  final List<String> pb = b.split('-');
  if (pa.length != 2 || pb.length != 2) return 0;
  final int ya = int.tryParse(pa[0]) ?? 0;
  final int yb = int.tryParse(pb[0]) ?? 0;
  if (ya != yb) return ya.compareTo(yb);
  final int ma = int.tryParse(pa[1]) ?? 0;
  final int mb = int.tryParse(pb[1]) ?? 0;
  return ma.compareTo(mb);
}

/// The CURRENT month as "YYYY-MM" — the latest date a work history may hold.
/// Read at call time (never cached) so the bound rolls over with the calendar
/// instead of going stale in a constant, the way the picker's old fixed
/// `_latestYear` did.
String _currentYearMonth() {
  final DateTime now = DateTime.now();
  return '${now.year}-${now.month.toString().padLeft(2, '0')}';
}

/// Validates ONE work-history date ("YYYY-MM"), returning the message to show
/// or null when it is sound. [requiredMessage] is used when the value is
/// missing. The bounds, in order: present → well-formed → not before
/// [_kEarliestWorkYear] → not in the future. The picker refuses an
/// out-of-range year/month up front; this is the fail-closed net for values
/// that arrive from saved/legacy data rather than a pick.
String? _dateFieldError(String? ym, {required String requiredMessage}) {
  if (ym == null) return requiredMessage;
  final List<String> parts = ym.split('-');
  if (parts.length != 2) return _kDateInvalidError;
  final int? year = int.tryParse(parts[0]);
  final int? month = int.tryParse(parts[1]);
  if (year == null || month == null || month < 1 || month > 12) {
    return _kDateInvalidError;
  }
  if (year < _kEarliestWorkYear) return _kDateTooOldError;
  if (_compareYearMonth(ym, _currentYearMonth()) > 0) {
    return _kDateFutureError;
  }
  return null;
}

class _EmployerCardState extends State<_EmployerCard> {
  late final TextEditingController _name = TextEditingController(
    text: widget.entry.employerName,
  );
  late final TextEditingController _role = TextEditingController(
    text: widget.entry.roleLabel,
  );
  late final TextEditingController _work = TextEditingController(
    text: widget.entry.workDone ?? '',
  );

  /// The switch reflects BOTH signals: an end date forces "not current", and
  /// an entry the worker left switched OFF with no end yet (a blocked, unsaved
  /// state) must come back OFF so the missing end field stays visible and the
  /// same block can fire again. Defaults ON for a fresh card ([stillWorking]
  /// defaults true and [endYm] is null).
  late bool _stillWorking =
      widget.entry.endYm == null && widget.entry.stillWorking;

  @override
  void dispose() {
    _name.dispose();
    _role.dispose();
    _work.dispose();
    super.dispose();
  }

  void _push(TradeFormEmploymentEntry next) => widget.onChanged(next);

  @override
  Widget build(BuildContext context) {
    final TradeFormEmploymentEntry e = widget.entry;
    return TradeFormCard(
      onRemove: widget.onRemove,
      removeTooltip: _kRemove,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const TradeFormFieldLabel(_kNameLabel),
          TradeFormTextField(
            controller: _name,
            hint: _kNameHint,
            label: _kNameLabel,
            onChanged: (String v) => _push(e.copyWith(employerName: v)),
          ),
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kRoleLabel),
          TradeFormTextField(
            controller: _role,
            hint: _kRoleHint,
            label: _kRoleLabel,
            onChanged: (String v) => _push(e.copyWith(roleLabel: v)),
          ),
          const SizedBox(height: 14),
          _EmployerLocationPicker(
            initialCity: e.employerCity,
            initialState: e.employerState,
            states: widget.states,
            citiesFor: widget.citiesFor,
            onChanged: (String? city, String? state) =>
                _push(e.copyWith(employerCity: city, employerState: state)),
          ),
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kStartLabel),
          _YearMonthField(
            value: e.startYm,
            onPicked: (String? ym) {
              if (ym != null &&
                  e.endYm != null &&
                  _compareYearMonth(ym, e.endYm) > 0) {
                ScaffoldMessenger.of(
                  context,
                ).showSnackBar(const SnackBar(content: Text(_kDateOrderError)));
                return;
              }
              _push(e.copyWith(startYm: ym));
            },
          ),
          const SizedBox(height: 14),
          TradeFormSwitchRow(
            label: _kStillWorking,
            value: _stillWorking,
            onChanged: (bool on) {
              setState(() => _stillWorking = on);
              // ON — current job: drop any end date. OFF — an end date is now
              // REQUIRED (see [currentPageError]); it is only dropped if the
              // worker had not picked one.
              _push(e.copyWith(stillWorking: on, endYm: on ? null : e.endYm));
            },
          ),
          if (!_stillWorking) ...<Widget>[
            const SizedBox(height: 14),
            const TradeFormFieldLabel(_kEndLabel),
            _YearMonthField(
              value: e.endYm,
              onPicked: (String? ym) {
                if (ym != null &&
                    e.startYm != null &&
                    _compareYearMonth(ym, e.startYm) < 0) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text(_kDateOrderError)),
                  );
                  return;
                }
                _push(e.copyWith(endYm: ym));
              },
            ),
          ],
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kWorkLabel),
          TradeFormTextField(
            controller: _work,
            hint: _kWorkHint,
            label: _kWorkLabel,
            maxLength: _kWorkDoneMax,
            maxLines: 3,
            textInputAction: TextInputAction.newline,
            // A HAND edit KEEPS the clip id: the text stays the answer of
            // record, and the clip is provenance for where that text started —
            // still true after the worker tidies the wording. Clearing the box
            // drops the id, which `toJson` enforces, because the server refuses
            // an id with no description.
            onChanged: (String v) => _push(e.copyWith(workDone: v)),
          ),
          TradeFormWorkDictation(
            controller: _work,
            enabled: true,
            maxLength: _kWorkDoneMax,
            // TREATED AS A HAND EDIT, clip id and all: `copyWith` leaves
            // `workDoneVoiceNoteId` exactly as it was. Dictation stores no
            // recording, so it has no id of its own to offer — and an entry that
            // already carries one from an older clip keeps it, because the text
            // is still the answer of record and the clip is still where that text
            // started. The field's own `onChanged` above documents the same rule.
            onText: (String text) => _push(e.copyWith(workDone: text)),
          ),
        ],
      ),
    );
  }
}

/// Employer city/state — a two-step "pick state, then pick a city filtered
/// to it" picker, now backed by the REAL server data (#1429): all 28 states
/// + 8 UTs from the state catalogue, and cities from the state-tagged
/// gazetteer. State ALWAYS renders before Sheher, in both the picker and the
/// free-text layout.
///
/// ── WHY THE FREE-TEXT PATH IS PERMANENT, NOT A LEFTOVER ─────────────────
/// The gazetteer is a closed set of MANUFACTURING HUBS — 36 cities across 13
/// states — not a map of India, and there is no authoritative India-wide city
/// dataset in this repo (owner ruling 2026-09-05, recorded on #1429: "ship
/// the state picker, leave employer city free text rather than invent a
/// dataset"). A PREVIOUS employer can be anywhere, so:
///  - every state is pickable, because the state list IS complete;
///  - a state the gazetteer has cities for offers them in the dropdown;
///  - a state it has none for drops straight to a free-text city field, so
///    picking e.g. Bihar is never a dead end;
///  - "Khud likhein" still escapes to free text for BOTH fields at any time.
/// Do not "finish" this by hiding the free-text path — it is the only way a
/// worker from the other 23 states/UTs can answer at all.
class _EmployerLocationPicker extends StatefulWidget {
  const _EmployerLocationPicker({
    required this.initialCity,
    required this.initialState,
    required this.states,
    required this.citiesFor,
    required this.onChanged,
  });

  final String? initialCity;
  final String? initialState;

  /// Every state/UT the server offers. Empty while the options fetch is in
  /// flight or after it failed — the picker then shows the free-text fields,
  /// never an empty dropdown.
  final List<String> states;

  /// The gazetteer's cities for one state; empty for most states.
  final List<String> Function(String state) citiesFor;

  /// Fires on every change, city and state independently nullable — mirrors
  /// the two free-text fields this replaces (either can be filled alone).
  final void Function(String? city, String? state) onChanged;

  @override
  State<_EmployerLocationPicker> createState() =>
      _EmployerLocationPickerState();
}

class _EmployerLocationPickerState extends State<_EmployerLocationPicker> {
  late bool _manual;
  String? _pickedState;
  late final TextEditingController _cityController = TextEditingController(
    text: widget.initialCity ?? '',
  );
  late final TextEditingController _stateController = TextEditingController(
    text: widget.initialState ?? '',
  );

  @override
  void initState() {
    super.initState();
    _manual = !_isPickable(widget.initialCity, widget.initialState);
    _pickedState = (widget.initialState != null &&
            widget.states.contains(widget.initialState))
        ? widget.initialState
        : null;
  }

  /// True for a BLANK entry (nothing typed yet — default to the picker, the
  /// preferred path) or a saved value the picker can actually represent:
  /// a known state, with a city that is either one the gazetteer lists for
  /// it or absent. False for pre-existing free text the picker cannot show —
  /// that data is preserved via the manual fields rather than silently
  /// hidden.
  bool _isPickable(String? city, String? state) {
    if ((city == null || city.isEmpty) && (state == null || state.isEmpty)) {
      return true;
    }
    if (state == null || !widget.states.contains(state)) return false;
    if (city == null || city.isEmpty) return true;
    return widget.citiesFor(state).contains(city);
  }

  @override
  void dispose() {
    _cityController.dispose();
    _stateController.dispose();
    super.dispose();
  }

  void _pickState(String state) {
    setState(() {
      _pickedState = state;
      _cityController.clear();
    });
    widget.onChanged(null, state);
  }

  void _pickCity(String city) {
    _cityController.text = city;
    setState(() {});
    widget.onChanged(city, _pickedState);
  }

  /// Opens the kit's searchable sheet; a dismissed sheet changes nothing —
  /// the same contract the old dropdown field had.
  Future<void> _openStateSheet() async {
    final String? picked = await showOnboardingPicker(
      context,
      title: _kStateLabel,
      options: widget.states,
      selected: _pickedState,
    );
    if (picked != null && mounted) _pickState(picked);
  }

  Future<void> _openCitySheet(List<String> cities) async {
    final String? picked = await showOnboardingPicker(
      context,
      title: _kCityLabel,
      options: cities,
      selected: _cityController.text.isEmpty ? null : _cityController.text,
    );
    if (picked != null && mounted) _pickCity(picked);
  }

  void _switchToManual() {
    setState(() {
      _manual = true;
      _cityController.text = widget.initialCity ?? _cityController.text;
      _stateController.text = widget.initialState ?? _stateController.text;
    });
  }

  void _switchToPicker() {
    setState(() {
      _manual = false;
      _pickedState = null;
      _cityController.clear();
    });
    widget.onChanged(null, null);
  }

  @override
  Widget build(BuildContext context) {
    if (_manual) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const TradeFormFieldLabel(_kStateLabel),
          TradeFormTextField(
            controller: _stateController,
            hint: _kStateHint,
            label: _kStateLabel,
            onChanged: (String v) =>
                widget.onChanged(_cityController.text, v),
          ),
          const SizedBox(height: 14),
          const TradeFormFieldLabel(_kCityLabel),
          TradeFormTextField(
            controller: _cityController,
            hint: _kCityHint,
            label: _kCityLabel,
            textInputAction: TextInputAction.done,
            onChanged: (String v) =>
                widget.onChanged(v, _stateController.text),
          ),
          _LocationLink(label: _kBackToPickerLink, onPressed: _switchToPicker),
        ],
      );
    }

    final List<String> cities =
        _pickedState == null
            ? const <String>[]
            : widget.citiesFor(_pickedState!);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormFieldLabel(_kStateLabel),
        OnboardingSelectField(
          value: _pickedState ?? '',
          hint: _kPickStateLabel,
          semanticLabel: _kStateLabel,
          onTap: _openStateSheet,
        ),
        const SizedBox(height: 14),
        const TradeFormFieldLabel(_kCityLabel),
        // A state the gazetteer lists cities for gets the dropdown; one it
        // does not (23 of the 36 states/UTs) gets a plain text field right
        // here, so picking e.g. Bihar leads to a field the worker can answer
        // instead of an empty menu. The gazetteer is a hub list, not a map of
        // India — see this widget's own doc.
        if (_pickedState != null && cities.isEmpty)
          TradeFormTextField(
            controller: _cityController,
            hint: _kCityHint,
            label: _kCityLabel,
            onChanged: (String v) => widget.onChanged(v, _pickedState),
          )
        else
          OnboardingSelectField(
            value: _cityController.text,
            hint: _kPickCityLabel,
            semanticLabel: _kCityLabel,
            enabled: _pickedState != null,
            onTap: () => _openCitySheet(cities),
          ),
        _LocationLink(label: _kManualEntryLink, onPressed: _switchToManual),
      ],
    );
  }
}

/// The picker ⇄ free-text escape, as a left-aligned text link at a 48px tap
/// target.
class _LocationLink extends StatelessWidget {
  const _LocationLink({required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: TextButton(
        onPressed: onPressed,
        style: TextButton.styleFrom(
          minimumSize: const Size(0, OnboardingLayout.tapTarget),
          padding: const EdgeInsets.symmetric(horizontal: 4),
          foregroundColor: OnboardingColors.shiftBlue,
        ),
        child: Text(
          label,
          style: OnboardingTypography.inter(
            size: 14,
            weight: FontWeight.w600,
            color: OnboardingColors.shiftBlue,
            decoration: TextDecoration.underline,
          ),
        ),
      ),
    );
  }
}

/// A month-precision date field, identical in behaviour to
/// `features/finishing`'s own `_YearMonthField` (a scoped duplicate — see
/// this file's class doc). Painted as a kit input (48px, 10 radius).
class _YearMonthField extends StatelessWidget {
  const _YearMonthField({required this.value, required this.onPicked});

  final String? value;
  final ValueChanged<String?> onPicked;

  String _display() {
    final String? v = value;
    if (v == null) return _kNotStated;
    final List<String> parts = v.split('-');
    if (parts.length != 2) return _kNotStated;
    final int? m = int.tryParse(parts[1]);
    final String month = (m != null && m >= 1 && m <= 12)
        ? _kMonths[m - 1]
        : parts[1];
    return '$month ${parts[0]}';
  }

  @override
  Widget build(BuildContext context) {
    final bool set = value != null;
    final BorderRadius radius =
        BorderRadius.circular(OnboardingRadii.nameField);
    return Material(
      color: OnboardingColors.paperWhite,
      borderRadius: radius,
      child: InkWell(
        onTap: () => _open(context),
        borderRadius: radius,
        child: Container(
          constraints:
              const BoxConstraints(minHeight: OnboardingLayout.tapTarget),
          // When set, the clear button's own 48px square supplies the right
          // edge and the height.
          padding: EdgeInsets.only(left: 14, right: set ? 0 : 14),
          decoration: BoxDecoration(
            borderRadius: radius,
            border: Border.all(
              color: OnboardingColors.borderDefault,
              width: 1.2,
            ),
          ),
          child: Row(
            children: <Widget>[
              const Icon(
                Icons.event_outlined,
                size: 20,
                color: OnboardingColors.ink600,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  _display(),
                  style: set
                      ? OnboardingTypography.inter(
                          size: 14,
                          weight: FontWeight.w500,
                        )
                      : OnboardingTypography.inter(
                          size: 14,
                          color: OnboardingColors.ink500,
                        ),
                ),
              ),
              if (set)
                IconButton(
                  onPressed: () => onPicked(null),
                  icon: const Icon(
                    Icons.close,
                    size: 18,
                    color: OnboardingColors.ink500,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _open(BuildContext context) async {
    final String? picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: OnboardingColors.paperWhite,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(OnboardingRadii.card),
        ),
      ),
      builder: (BuildContext ctx) => const _YearMonthSheet(),
    );
    if (picked != null) onPicked(picked);
  }
}

class _YearMonthSheet extends StatefulWidget {
  const _YearMonthSheet();

  @override
  State<_YearMonthSheet> createState() => _YearMonthSheetState();
}

class _YearMonthSheetState extends State<_YearMonthSheet> {
  int? _year;

  @override
  Widget build(BuildContext context) {
    final DateTime now = DateTime.now();
    // Newest first, and never a future one: the top chip is the CURRENT year
    // and the floor is [_kEarliestWorkYear], so "1900" and next year cannot be
    // chosen at all. The current year only offers months up to TODAY, which
    // closes the last future slot (picking December while it is September).
    final int firstMonthThisYear = _year == now.year ? now.month : 12;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              _year == null ? _kPickYear : _kPickMonth,
              style: OnboardingTypography.anek(size: 18),
            ),
            const SizedBox(height: 14),
            // The year chips do not fit a 568px screen — the list scrolls
            // inside the sheet instead of overflowing it.
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(context).height * 0.55,
              ),
              child: SingleChildScrollView(
                child: _year == null
                    ? Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: <Widget>[
                          for (int y = now.year; y >= _kEarliestWorkYear; y--)
                            TradeFormPillChip(
                              label: '$y',
                              labelStyle: OnboardingTypography.mono(
                                size: 14,
                                weight: FontWeight.w600,
                                color: OnboardingColors.ink900,
                              ),
                              onTap: () => setState(() => _year = y),
                            ),
                        ],
                      )
                    : Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: <Widget>[
                          for (int m = 1; m <= firstMonthThisYear; m++)
                            TradeFormPillChip(
                              label: _kMonths[m - 1],
                              onTap: () => Navigator.of(
                                context,
                              ).pop('${_year!}-${m.toString().padLeft(2, '0')}'),
                            ),
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
