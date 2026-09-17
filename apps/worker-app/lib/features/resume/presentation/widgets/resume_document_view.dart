import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_reason.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/kit/kit_callout.dart';
import '../../../../core/widgets/kit/kit_card.dart';
import '../../../../core/widgets/kit/kit_check_row.dart';
import '../../../../core/widgets/kit/kit_info_chip.dart';
import '../../../../core/widgets/kit/kit_micro_label.dart';
import '../cubit/resume_cubit.dart';
import 'resume_card_slots.dart';

/// Gap between two v3 cards in the resume stack.
const double kResumeCardGap = 12;

/// The profiling ROAD a structured resume document came from (#1525).
///
/// `source` is the road that produced the PROFILE, not the layout: a chat-road
/// worker whose trade happens to have an authored sheet still gets a
/// `format: "trade_sheet"` [TradeSheetResumeDocument] on the wire. Rendering
/// therefore keys on this road (when known), and only falls back to the
/// layout-by-format switch for [ResumeRoad.unknown] — an old server build or a
/// pre-migration row, whose `source` is null.
enum ResumeRoad { form, chat, unknown }

/// Classifies a document by its profile road.
///
/// [ResumeDocument.source] is already normalised to `'form' | 'chat' | null`
/// by [ResumeDocument.sourceFrom], so null is UNKNOWN and is deliberately kept
/// apart from [ResumeRoad.form]: both render through today's layout-by-format
/// path, but only knowledge of the road is allowed to move a document OFF that
/// path, never the absence of it.
ResumeRoad resumeRoadOf(ResumeDocument? document) => switch (document?.source) {
  'chat' => ResumeRoad.chat,
  'form' => ResumeRoad.form,
  _ => ResumeRoad.unknown,
};

/// The chat-road resume's heading (#1525).
///
/// The road, stated plainly, is the one thing that makes this document its own
/// type rather than a trade sheet that happened to come from an interview.
const String kChatResumeHeading = 'Chat se bana resume';

/// The muted line under [kChatResumeHeading]. Deliberately about the ROAD, not
/// about quality — a chat-road resume is neither better nor worse than a form
/// one, only built a different way.
const String kChatResumeSubline = 'Aapse baat-cheet ke jawabon par bana';

/// #1525 — the CHAT-ROAD resume, rendered as its OWN type.
///
/// It never draws the trade sheet's zoned cards, even when the wire's `format`
/// is `trade_sheet`, because those cards are the form road's authored-sheet
/// presentation. Its [child] is the flat, sectioned resume body the generic /
/// legacy path already produces — the same real content, under a heading that
/// names the road it came from.
///
/// [child] is handed in rather than built here so the screen keeps the single
/// [`_legacyResumeBody`] construction (raw-text fallback included) and the
/// `format: "generic"` / `document == null` paths cannot drift from this one.
class ChatResumeView extends StatelessWidget {
  const ChatResumeView({super.key, required this.child});

  /// The flat resume body to draw under the chat heading.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        KitCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const KitCardHeader(
                icon: Icons.chat_bubble_outline_rounded,
                title: kChatResumeHeading,
              ),
              const SizedBox(height: 8),
              Text(
                kChatResumeSubline,
                style: OnboardingTypography.inter(
                  size: 12,
                  height: 1.35,
                  color: OnboardingColors.ink500,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: kResumeCardGap),
        child,
      ],
    );
  }
}

/// #1343 / UI kit v3 §4 — renders a `format: "trade_sheet"`
/// [TradeSheetResumeDocument] as the spec's white cards: machines and
/// controllers, materials, operations and tooling, then every zone the spec
/// does not model, then the work history or the training block.
///
/// `format: "generic"` and `document == null` are DELIBERATELY NOT handled
/// here — see the call site in `resume_preview_screen.dart`, which still
/// renders those two through the existing (unchanged) `resume_text` parsing
/// path. That path already reads correctly for a non-CNC worker (the
/// acceptance bar in #1343), and [GenericResumeDocument]'s fields are the same
/// facts that text-parser already surfaces, so there is nothing here for it to
/// fix. Only the trade sheet is a layout the OLD renderer structurally cannot
/// draw.
///
/// It does NOT draw the masthead headline any more: spec §4 puts the trade
/// verdict in the profile card, so the headline is resolved there (see
/// [resolveProfileFacts]) and printing it here too would show it twice.
///
/// Which card a row lands in is decided by [mapTradeSheet], never by matching
/// English label text — see that file for why, and for the rule that an
/// unknown row is still rendered rather than dropped.
class ResumeDocumentView extends StatelessWidget {
  const ResumeDocumentView({super.key, required this.document});

  final TradeSheetResumeDocument document;

  @override
  Widget build(BuildContext context) {
    final ResumeSlots slots = mapTradeSheet(document);
    final List<Widget> cards = <Widget>[
      if (slots.hasCapabilityCard) _CapabilityCard(slots: slots),
      if (slots.hasMaterialsCard) _MaterialsCard(slots: slots),
      if (slots.hasOperationsCard) _OperationsCard(slots: slots),
      for (final ResumeExtraSection section in slots.extraSections)
        _ExtraSectionCard(section: section),
      if (document.employments.isNotEmpty) _WorkHistoryCard(document: document),
      // A fresher has training INSTEAD of a work history, never both, so this
      // sits where the history would have been rather than after it.
      if (document.experiences.isNotEmpty) _TrainingCard(document: document),
      if (document.footerMeta != null && document.footerMeta!.isNotEmpty)
        Text(
          document.footerMeta!,
          style: OnboardingTypography.inter(
            size: 11,
            color: OnboardingColors.ink500,
          ),
        ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int i = 0; i < cards.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(height: kResumeCardGap),
          cards[i],
        ],
      ],
    );
  }
}

/// Spec §4 card 2 — machines operated and controllers known.
class _CapabilityCard extends StatelessWidget {
  const _CapabilityCard({required this.slots});

  final ResumeSlots slots;

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _CardHeader(
            icon: Icons.settings_suggest_rounded,
            // The SERVER's own zone title, so a welder's card does not claim
            // to be about CNC controllers (spec's title is turner-only).
            title: slots.capabilityTitle ?? 'Machines & controllers',
            count: slots.capabilityCount,
          ),
          if (slots.machines.isNotEmpty) ...<Widget>[
            const SizedBox(height: 12),
            const KitMicroLabel('OPERATED MACHINES'),
            const SizedBox(height: 8),
            _ValueMatrix(values: slots.machines),
          ],
          if (slots.controllers.isNotEmpty) ...<Widget>[
            const SizedBox(height: 14),
            const KitMicroLabel('CONTROLLERS KNOWN'),
            const SizedBox(height: 8),
            // The ONE group that keeps full-width rows however short its
            // values measure — spec §4's scannable controller list (see
            // [kControllerRowKey] for why this one is worth the space).
            _ValueMatrix(values: slots.controllers),
          ],
        ],
      ),
    );
  }
}

/// Spec §4 card 3 — materials handled.
class _MaterialsCard extends StatelessWidget {
  const _MaterialsCard({required this.slots});

  final ResumeSlots slots;

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _CardHeader(
            icon: Icons.category_rounded,
            iconColor: OnboardingColors.safetyYellow,
            // The server's own row label ('Materials', 'Tool steels',
            // 'Electrode types'…). The spec's '4 Alloys' is wrong for brass,
            // aluminium or a powder coating, and there is no material-category
            // data to colour a dot by (backend gap B13) — so the pill is a
            // plain count and every dot is the same neutral green.
            title: slots.materialsTitle ?? 'Materials',
            count: slots.materials.length,
          ),
          const SizedBox(height: 12),
          _ValueMatrix(values: slots.materials),
        ],
      ),
    );
  }
}

/// Spec §4 card 4 — operations, workholding, inspection, the drawing callout,
/// and every other capability row the sheet carried.
class _OperationsCard extends StatelessWidget {
  const _OperationsCard({required this.slots});

  final ResumeSlots slots;

  @override
  Widget build(BuildContext context) {
    final List<Widget> blocks = <Widget>[
      if (slots.operations.isNotEmpty)
        _LabelledBlock(
          label: slots.operationsTitle ?? 'Operations',
          child: _ValueMatrix(values: slots.operations),
        ),
      if (slots.workholding.isNotEmpty)
        _LabelledBlock(
          label: 'WORKHOLDING KNOWLEDGE',
          child: _ValueMatrix(values: slots.workholding),
        ),
      // Measuring instruments, quality and inspection rows pack like the
      // operations above them now: the sheet prints them with ticks, but
      // 'Micrometer' and 'Vernier caliper' are two words, not two rows.
      for (final ResumeValueGroup group in slots.instrumentGroups)
        _LabelledBlock(
          label: group.label,
          child: _ValueMatrix(values: group.values),
        ),
      // Never dropped: a row whose key this build does not know still prints,
      // under the label the server gave it.
      for (final ResumeValueGroup group in slots.otherGroups)
        _LabelledBlock(
          label: group.label,
          child: _ValueMatrix(values: group.values),
        ),
      if (slots.drawingReading != null)
        KitCallout(
          tileIcon: Icons.menu_book_rounded,
          // NEUTRAL title: the spec shouts 'BLUEPRINTS & GD&T KNOWLEDGE' even
          // when the value says only 'Reads 2D drawings', which would put a
          // GD&T claim on a worker who never made one.
          title: 'DRAWING READING',
          text: slots.drawingReading,
        ),
      for (final ResumeFact fact in slots.otherFacts) _FactLine(fact: fact),
    ];

    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _CardHeader(
            icon: Icons.construction_rounded,
            iconColor: OnboardingColors.successGreen,
            title:
                slots.operationsTitle ??
                (slots.hasCapabilityCard
                    ? 'Skills & tooling'
                    : slots.capabilityTitle ?? 'Skills & tooling'),
            count: slots.operations.length,
          ),
          for (final Widget block in blocks) ...<Widget>[
            const SizedBox(height: 12),
            block,
          ],
        ],
      ),
    );
  }
}

/// A zone spec §4 does not model — 'Availability & terms', 'Qualification,
/// documents & languages', or a future zone. Same card chrome, so the tab
/// reads as one design rather than two renderers bolted together.
class _ExtraSectionCard extends StatelessWidget {
  const _ExtraSectionCard({required this.section});

  final ResumeExtraSection section;

  static IconData _icon(String id) => switch (id) {
    'terms' => Icons.event_available_outlined,
    'qualifications' => Icons.school_outlined,
    _ => Icons.info_outline_rounded,
  };

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _CardHeader(icon: _icon(section.id), title: section.title),
          // Both row styles draw through the SAME matrix. The sheet's tick
          // rows are this card's 'Documents ready: Aadhaar, PAN, UAN' — three
          // short words that were costing three full-width rows on the
          // 'Qualification, documents & languages' card.
          for (final ResumeValueGroup group in section.chipGroups) ...<Widget>[
            const SizedBox(height: 12),
            _LabelledBlock(
              label: group.label,
              child: _ValueMatrix(values: group.values),
            ),
          ],
          for (final ResumeValueGroup group in section.tickGroups) ...<Widget>[
            const SizedBox(height: 12),
            _LabelledBlock(
              label: group.label,
              child: _ValueMatrix(values: group.values),
            ),
          ],
          for (final ResumeFact fact in section.facts) ...<Widget>[
            const SizedBox(height: 10),
            _FactLine(fact: fact),
          ],
        ],
      ),
    );
  }
}

/// The sheet's work-history zone.
class _WorkHistoryCard extends StatelessWidget {
  const _WorkHistoryCard({required this.document});

  final TradeSheetResumeDocument document;

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _CardHeader(
            icon: Icons.work_history_outlined,
            title: 'Work History',
          ),
          // ONE CHILD PER VISUAL ROW, and no spacers of our own (#1475). A
          // spacer handed in as a child gets padded on BOTH sides, which is
          // what put two employments three gaps apart instead of one.
          for (final ResumeEmploymentDto e in document.employments) ...<Widget>[
            const SizedBox(height: 12),
            _EmploymentEntry(employment: e),
          ],
          if (document.employmentsMore != null &&
              document.employmentsMore!.isNotEmpty) ...<Widget>[
            const SizedBox(height: 12),
            Text(
              document.employmentsMore!,
              style: OnboardingTypography.inter(
                size: 12,
                color: OnboardingColors.ink500,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The fresher's TRAINING zone — what he has instead of a work history
/// (#1476).
///
/// The sheet did not carry this at all before: `experiences` was a field of
/// the generic document only. So his `iti_project_work` sentence printed on
/// the PDF an employer reads while his own resume tab showed nothing of it —
/// the one person who can say whether a sentence about his training is true
/// never saw it.
class _TrainingCard extends StatelessWidget {
  const _TrainingCard({required this.document});

  final TradeSheetResumeDocument document;

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _CardHeader(icon: Icons.school_outlined, title: 'Training'),
          for (final ResumeExperienceLineDto line
              in document.experiences) ...<Widget>[
            const SizedBox(height: 12),
            _TrainingEntry(line: line),
          ],
        ],
      ),
    );
  }
}

/// A card's header row: a tone-coloured glyph, the title, and a REAL count.
///
/// The count pill is digits only and hidden at 0 (ruling R8). The spec's
/// '7 Verified' cannot be honest — capability values are self-declared, and
/// no per-value verification signal exists on the wire (backend gap B8), so
/// printing "Verified" would tell an employer something nobody checked.
class _CardHeader extends StatelessWidget {
  const _CardHeader({
    required this.icon,
    required this.title,
    this.iconColor = OnboardingColors.shiftBlue,
    this.count,
  });

  final IconData icon;
  final String title;
  final Color iconColor;
  final int? count;

  @override
  Widget build(BuildContext context) {
    return KitCardHeader(
      icon: icon,
      title: title,
      iconColor: iconColor,
      count: count,
    );
  }
}

/// A micro label over a group of values.
class _LabelledBlock extends StatelessWidget {
  const _LabelledBlock({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        KitMicroLabel(label),
        const SizedBox(height: 8),
        child,
      ],
    );
  }
}

/// A value group's values — the WRAPPING CHIP MATRIX by default, full-width
/// rows only where a value cannot read as a chip.
///
/// This is the one place either drawing is chosen, so every card in the tab
/// packs its values the same way. The decision comes from the VALUES
/// ([valuesReadAsChips]) rather than from the sheet's `tick` flag, which is why
/// the instrument, setting and documents groups now sit several to a row
/// instead of one per line — see [kChipValueMaxChars] for the threshold and the
/// measurement behind it.
///
/// THERE IS NO PER-GROUP EXCEPTION. 'CONTROLLERS KNOWN' used to be forced to
/// full-width rows because spec §4 draws it that way, but a controller
/// designation is as short as an operation ('Fanuc Oi-TF', 'Siemens 828D'), so
/// the owner ruled it packs like every other group. The only thing that still
/// sends a group to rows is a value too long to read as a chip, which is a
/// property of the DATA — so a controller string that ever arrives long
/// (a full 'Fanuc Series 0i-TF Plus with manual guide i') still gets rows
/// rather than being truncated.
///
/// An empty group draws NOTHING: real data only, and a row is never padded to
/// make a card look full.
class _ValueMatrix extends StatelessWidget {
  const _ValueMatrix({required this.values});

  final List<String> values;

  @override
  Widget build(BuildContext context) {
    if (values.isEmpty) return const SizedBox.shrink();
    return valuesReadAsChips(values)
        ? _ChipWrap(values: values)
        : _CheckRows(values: values);
  }
}

/// Spec §4's chip wrap — the horizontal matrix, several values per row. No
/// green check: a tick means "someone verified this", and nobody did (see
/// [_CardHeader]).
class _ChipWrap extends StatelessWidget {
  const _ChipWrap({required this.values});

  final List<String> values;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: <Widget>[
        for (final String value in values) KitInfoChip(label: value),
      ],
    );
  }
}

/// Full-width rows — the FALLBACK, for the controller list and for a group
/// whose values are long sentences a chip would truncate (spec §4's
/// 'CONTROLLERS KNOWN' list). Reached only through [_ValueMatrix], so the two
/// drawings can never drift apart.
///
/// Same design family as the chips by construction: `KitCheckRow` is the kit's
/// row form of the same fact, so a group that falls back still reads as part of
/// the same card rather than as a second renderer.
class _CheckRows extends StatelessWidget {
  const _CheckRows({required this.values});

  final List<String> values;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int i = 0; i < values.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(height: 6),
          KitCheckRow(label: values[i]),
        ],
      ],
    );
  }
}

/// One `Label: value` fact — the same reading the text-parsed renderer gives
/// it, so a trade-sheet fact and a legacy fact are the same line.
class _FactLine extends StatelessWidget {
  const _FactLine({required this.fact});

  final ResumeFact fact;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        style: OnboardingTypography.inter(size: 13, height: 1.4),
        children: <InlineSpan>[
          TextSpan(
            text: '${fact.label}: ',
            style: OnboardingTypography.inter(
              size: 13,
              height: 1.4,
              color: OnboardingColors.ink600,
            ),
          ),
          TextSpan(
            text: fact.value,
            style: OnboardingTypography.inter(
              size: 13,
              weight: FontWeight.w600,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

/// One employer on the work-history card — employer (+ role/location inline
/// suffixes, already separator-prefixed server-side), its span, the work
/// description, then any promotion stints.
///
/// #1353/#1354 — STATEFUL only for the own-words reveal/choice affordance
/// below the work line (see [_OwnWordsChoice]); everything else is the
/// unchanged #1343 render.
class _EmploymentEntry extends StatefulWidget {
  const _EmploymentEntry({required this.employment});

  final ResumeEmploymentDto employment;

  @override
  State<_EmploymentEntry> createState() => _EmploymentEntryState();
}

class _EmploymentEntryState extends State<_EmploymentEntry> {
  bool _revealed = false;
  bool _pending = false;

  /// Set the moment THIS screen visit calls `ownWords: true` for this entry.
  ///
  /// The wire's [ResumeEmploymentDto.hasOwnWordsToReveal] cannot tell "never
  /// rewritten" apart from "the worker already declined the rewrite" — both
  /// leave `work == workOwnWords`, by design (see that getter's own doc). So
  /// once the worker keeps their own words, the wire alone can no longer offer
  /// a way back to the polished version. This remembers the worker's OWN
  /// action, in memory, for the rest of this screen visit only — never
  /// persisted, never guessed from server state — so "switch back" (the flow
  /// spec's reversibility requirement) stays reachable the same way it was
  /// offered.
  bool _justKeptOwnWords = false;

  Future<void> _choose(bool ownWords) async {
    final String? id = widget.employment.id;
    if (id == null || _pending) return;
    setState(() => _pending = true);
    try {
      await context.read<ResumeCubit>().setEmploymentDescriptionSource(
        id,
        ownWords: ownWords,
      );
      if (!mounted) return;
      setState(() {
        _justKeptOwnWords = ownWords;
        // Nothing left to compare once the printed line already is the
        // worker's own words.
        if (ownWords) _revealed = false;
      });
    } on Failure catch (f) {
      // #1353 — the worker tapped a deliberate choice about a sentence
      // carrying their name; a failed write must surface honestly, never
      // look like it silently worked (mirrors ResumeCubit's own doc).
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(failureReason(f).reason)));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ResumeEmploymentDto employment = widget.employment;
    final String heading =
        '${employment.employer}${employment.roleInline ?? ''}${employment.locationSuffix ?? ''}';
    // A genuine rewrite to compare, with an id to act on. See the DTO's own
    // doc — an entry that was never rewritten and one whose rewrite was
    // already declined are indistinguishable here, by design, and both
    // correctly show nothing (below).
    final bool canOfferOwnWords =
        employment.id != null && employment.hasOwnWordsToReveal;
    final bool canOfferPolishedBack =
        !canOfferOwnWords && employment.id != null && _justKeptOwnWords;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (heading.isNotEmpty)
          Text(
            heading,
            style: OnboardingTypography.inter(
              size: 14,
              weight: FontWeight.w700,
              height: 1.35,
            ),
          ),
        if (employment.when.isNotEmpty)
          Text(
            employment.when,
            style: OnboardingTypography.inter(
              size: 12,
              color: OnboardingColors.ink500,
            ),
          ),
        if (employment.work.isNotEmpty) ...<Widget>[
          const SizedBox(height: 4),
          Text(
            employment.work,
            style: OnboardingTypography.inter(size: 13, height: 1.45),
          ),
        ],
        // #1353/#1354 — an entry with nothing to compare shows NOTHING extra:
        // no affordance, no disabled/greyed placeholder.
        if (canOfferOwnWords) ...<Widget>[
          const SizedBox(height: 8),
          _OwnWordsChoice(
            revealed: _revealed,
            pending: _pending,
            ownWordsText: employment.workOwnWords!,
            onToggle: () => setState(() => _revealed = !_revealed),
            onKeep: () => _choose(true),
          ),
        ] else if (canOfferPolishedBack) ...<Widget>[
          const SizedBox(height: 8),
          BbButton(
            label: 'Polish kiya version rakhein',
            onPressed: () => _choose(false),
            variant: BbButtonVariant.tonal,
            size: BbButtonSize.md,
            loading: _pending,
          ),
        ],
        for (final ResumeEmploymentRoleStintDto stint in employment.roles)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '${stint.role} · ${stint.when}',
              style: OnboardingTypography.inter(
                size: 12,
                color: OnboardingColors.ink600,
              ),
            ),
          ),
      ],
    );
  }
}

/// One training block on the sheet, with the reveal beside it (#1476).
///
/// The fresher's counterpart to [_EmploymentEntry]: the printed line, and —
/// only when a model rewrote it — a quiet link to see the sentence he actually
/// wrote. Stateful for exactly the same reason that one is: the reveal is a
/// LOCAL toggle and must not reset every time the tab rebuilds.
///
/// THE REFUSAL SHIPS TOO (#1492). #1476 gave him only the reveal, because at
/// the time there was no column and no route to call — a button that silently
/// failed would have been worse than none, since he would have believed he had
/// kept his words. Migration 0103 and
/// `PUT /workers/me/answers/:attributeKey/text-source` both landed, so he can
/// act on the comparison rather than only look at it.
///
/// ONE-WAY FROM HERE, and deliberately symmetric with #1354: after a refusal
/// the server has nothing left to compare, so `work_own_words` and
/// `own_words_key` both drop out of the next document and the affordance
/// disappears. The employment path behaves identically. A change-your-mind
/// toggle would need the document to carry the declined STATE rather than just
/// the comparison — a backend change, on both paths at once, not something to
/// fake here.
class _TrainingEntry extends StatefulWidget {
  const _TrainingEntry({required this.line});

  final ResumeExperienceLineDto line;

  @override
  State<_TrainingEntry> createState() => _TrainingEntryState();
}

class _TrainingEntryState extends State<_TrainingEntry> {
  bool _revealed = false;

  /// True while the refusal is in flight, so a second tap cannot fire it twice.
  bool _pending = false;

  Future<void> _keepOwnWords() async {
    final String? key = widget.line.ownWordsKey;
    if (key == null || _pending) return;
    setState(() => _pending = true);
    try {
      await context.read<ResumeCubit>().setAnswerTextSource(
        key,
        ownWords: true,
      );
      if (!mounted) return;
      // Nothing left to compare once the printed line already IS his own
      // words — collapse rather than leave a panel showing two equal strings.
      setState(() => _revealed = false);
    } on Failure catch (f) {
      // He tapped a deliberate choice about a sentence carrying his name. A
      // failed write must surface honestly, never look like it silently
      // worked — the same rule `_EmploymentEntry._choose` follows.
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(failureReason(f).reason)));
    } finally {
      if (mounted) setState(() => _pending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ResumeExperienceLineDto line = widget.line;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (line.role.isNotEmpty)
          Text(
            line.role,
            style: OnboardingTypography.inter(
              size: 14,
              weight: FontWeight.w700,
              height: 1.35,
            ),
          ),
        if (line.duration.isNotEmpty)
          Text(
            line.duration,
            style: OnboardingTypography.inter(
              size: 12,
              color: OnboardingColors.ink500,
            ),
          ),
        if (line.work.isNotEmpty) ...<Widget>[
          const SizedBox(height: 4),
          Text(
            line.work,
            style: OnboardingTypography.inter(size: 13, height: 1.45),
          ),
        ],
        // Nothing to compare ⇒ nothing extra. No affordance, no greyed
        // placeholder — the same rule the employment entry follows.
        //
        // `canRefuseRewrite`, not `hasOwnWords`: the words AND the address
        // arrive together or not at all (see the DTO), so this is the one
        // condition — and it keeps the button off screen in the impossible
        // state where a comparison has no key to send the refusal to.
        if (line.canRefuseRewrite) ...<Widget>[
          const SizedBox(height: 8),
          _OwnWordsChoice(
            revealed: _revealed,
            pending: _pending,
            ownWordsText: line.workOwnWords!,
            onToggle: () => setState(() => _revealed = !_revealed),
            onKeep: _keepOwnWords,
          ),
        ],
      ],
    );
  }
}

/// #1353/#1354 — the reveal-then-choose affordance for ONE entry whose printed
/// line was rewritten: a quiet link that reveals [ownWordsText] (the worker's
/// own words, unrewritten), then an EQUALLY-WEIGHTED button to keep them over
/// the polish. Deliberately never [BbButtonVariant.danger] (or any warning
/// styling) — keeping one's own words is a first-class choice, not a
/// downgrade, and needs no "are you sure".
class _OwnWordsChoice extends StatelessWidget {
  const _OwnWordsChoice({
    required this.revealed,
    required this.pending,
    required this.ownWordsText,
    required this.onToggle,
    this.onKeep,
  });

  final bool revealed;
  final bool pending;
  final String ownWordsText;
  final VoidCallback onToggle;

  /// Null when the choice cannot be PERSISTED for this path. A button that
  /// silently failed to keep the worker's words would be worse than no
  /// button, so it is simply absent.
  final VoidCallback? onKeep;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _RevealLink(
          label: revealed
              ? 'Likha hua version chhupayein'
              : 'Aapke apne shabdon mein dekhein',
          icon: revealed
              ? Icons.expand_less_rounded
              : Icons.expand_more_rounded,
          onTap: onToggle,
        ),
        if (revealed) ...<Widget>[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: OnboardingColors.surfaceMuted,
              borderRadius: BorderRadius.circular(OnboardingRadii.row),
              border: Border.all(color: OnboardingColors.borderSubtle),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                // NOT a KitMicroLabel: that shouts its text (spec §4's
                // ALL-CAPS group labels), and this is a Hinglish sentence
                // fragment addressed to the worker, not a data-group heading.
                // All-caps Latin Hinglish is measurably harder to read for the
                // reader this app is for, and the copy ships verbatim (§15).
                Text(
                  'Aapke shabdon mein',
                  style: OnboardingTypography.inter(
                    size: 11,
                    weight: FontWeight.w700,
                    color: OnboardingColors.ink600,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  ownWordsText,
                  style: OnboardingTypography.inter(size: 13, height: 1.45),
                ),
                if (onKeep != null) ...<Widget>[
                  const SizedBox(height: 12),
                  BbButton(
                    label: 'Apne shabd rakhein',
                    onPressed: onKeep,
                    variant: BbButtonVariant.tonal,
                    size: BbButtonSize.md,
                    loading: pending,
                  ),
                ],
              ],
            ),
          ),
        ],
      ],
    );
  }
}

/// A quiet, tappable text link (icon + label) — used only for the LOCAL
/// reveal/collapse toggle, which never touches the network (the choice
/// itself is a [BbButton], see [_OwnWordsChoice]). Padded to the worker
/// tap-target floor rather than sized to its text.
class _RevealLink extends StatelessWidget {
  const _RevealLink({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        child: Container(
          constraints: const BoxConstraints(
            minHeight: OnboardingLayout.tapTarget,
          ),
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(icon, size: 18, color: OnboardingColors.shiftBlue),
              const SizedBox(width: 4),
              // FLEXIBLE, and it has to be: "Aapke apne shabdon mein dekhein"
              // beside its icon overflowed a 360dp phone by 128px — a real
              // RenderFlex error on the narrowest handset the product targets.
              // The existing tests never saw it because a widget test's default
              // surface is 800dp wide. It wraps to a second line now rather
              // than being clipped.
              Flexible(
                child: Text(
                  label,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w700,
                    color: OnboardingColors.shiftBlue,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
