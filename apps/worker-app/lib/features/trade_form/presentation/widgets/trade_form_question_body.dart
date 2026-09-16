import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/form_flow_parts.dart';
import '../../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../../core/widgets/onboarding/onboarding_select_field.dart';
import '../../../../core/widgets/onboarding/option_icons.dart';
import '../../../../core/widgets/onboarding/questionnaire_bottom_bar.dart';
import '../../../../core/widgets/onboarding/selection_cards.dart';
import '../../../name/domain/indian_locations.dart';
import '../../../voice/domain/speech_reader.dart';
import '../../../voice_form/domain/voice_form_models.dart';
import '../../../voice_form/presentation/widgets/voice_choice_chips.dart'
    show applyNoneOfAboveRule, kVoiceBooleanNo, kVoiceBooleanYes, kVoiceFinalSubmit;
import '../../domain/form_fact_registry.dart'
    show kTradeFormCurrentCityQuestionKey;
import '../../domain/trade_form_models.dart';
import 'tenure_tier_labels.dart';
import 'trade_form_kit.dart';
import 'trade_form_text_field.dart';

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.
const String _kWhyLabel = 'Yeh kyun poochh rahe hain';
const String _kTextSubmit = 'Aage badhein';
const String _kTextHint = 'Yahan likhein';
const String kTradeFormDeclineLabel = 'Pata nahi / Baad mein batayein';
// The search box's copy is carried over verbatim from the
// `BbSearchableMultiSelect` this screen used before the kit redesign.
const String _kSearchLabel = 'Search karein';
const String _kSearchHint = 'Type karke dhoondein';
const String _kSearchEmpty = 'Koi option nahi mila. Doosra shabd try karein.';
// The current-city pickers — the same State → City steps /name uses.
const String _kCityStateLabel = 'State (Rajya)';
const String _kCityCityLabel = 'Sheher (City)';
const String _kCityStateHint = 'STATE CHUNEIN';
const String _kCityCityHint = 'SHEHER CHUNEIN';
const String _kCityStateSheetTitle = 'State chunein';
const String _kCityCitySheetTitle = 'Sheher chunein';

/// The server's own cap on `current_city`, as /name enforces it.
const int _kMaxCityLength = 80;

/// #1499 — the ONE line that introduces whatever a worker's uploaded résumé
/// said about this question. The wording is the ruling's own: it states where
/// the value came from and then ASKS, because a suggestion is a question and a
/// screen that presents it as a finding gets agreement instead of an answer.
const String _kSuggestionConfirm = 'Aapke resume mein ye tha — sahi hai';

/// #1499 — the small tag on an option card the résumé pointed at. It names
/// WHERE the hint came from and claims nothing: the card under it stays
/// unticked until the worker ticks it.
const String kTradeFormSuggestedTag = 'Resume mein tha';

/// Renders ONE `type: "question"` screen and reports the worker's answer.
///
/// Painted with the Master UI Kit and the form-flow mockups (Workholding /
/// Measuring / Operations): the prompt in `questionHeadline`, the why text, a
/// [FormHintChip] on multi-select questions, options as kit cards each with an
/// [iconForOption] tile, the [FormDeclineLink], and ONE docked
/// [QuestionnaireBottomBar] for every kind.
///
/// - **multi-select** → [MultiSelectQuestionCard]s; ticks accumulate behind
///   the docked bar. The none-of-above exclusivity (#1382) is
///   [applyNoneOfAboveRule], unchanged.
/// - **single-select / boolean** → [SingleSelectQuestionCard]s (boolean's
///   Haan / Nahi are client-owned, as before). KIT REDESIGN CHANGE: the kit
///   pins a Next bar under a radio list, so a tap now SELECTS — pre-selected
///   from a saved answer — and the bar's "Aage badhein" submits it. It used to
///   submit on tap. The submitted payload is identical (`[key]` /
///   `true|false`).
/// - **searchable** (`ui.searchable`, server-computed from option count) → a
///   kit search box above the same card list. A selected option — and a
///   résumé-suggested one (#1499) — is never filtered away. Single- vs
///   multi-select behave exactly as in the non-searchable list.
/// - **open** (`text`/`number` `answer_type`) → a plain text field, submit
///   enabled once non-empty (matching the server's `text.trim().min(1)`
///   rule).
///
/// The docked bar is a sibling of the scrollable prompt/options above it, so it
/// never scrolls out of reach on a long question. Its listen button reads the
/// prompt (and the why text) aloud on the device when a [speechReader] is
/// given, and is absent otherwise — never a dead button. It reads only the
/// server's question copy, never what the worker entered.
///
/// EVERY branch also renders an explicit decline affordance — "nothing here
/// applies" is a real, settled answer (`{kind: declined}`), never a silent
/// skip, per #1341.
class TradeFormQuestionBody extends StatefulWidget {
  const TradeFormQuestionBody({
    super.key,
    required this.step,
    required this.enabled,
    required this.onSubmitChips,
    required this.onSubmitBoolean,
    required this.onSubmitText,
    required this.onDecline,
    required this.isLastStep,
    this.speechReader,
  });

  final TradeFormQuestionStep step;

  /// The device read-aloud behind the docked bar's listen button. Passed IN
  /// (resolved by the screen) rather than read from the locator here, so this
  /// widget keeps working under a bare test harness. Null hides the button.
  final SpeechReader? speechReader;

  /// False while a submit is already in flight — every affordance below is
  /// disabled rather than allowing a second concurrent answer.
  final bool enabled;

  final ValueChanged<List<String>> onSubmitChips;
  final ValueChanged<bool> onSubmitBoolean;
  final ValueChanged<String> onSubmitText;
  final VoidCallback onDecline;

  /// #1384 item 3 — `TradeFormState.isLastStep`, threaded down so the docked
  /// submit bar can show the [kVoiceFinalSubmit] treatment ONLY when this
  /// question is truly the walk's last step — #1376 made that a reliable
  /// signal (see `TradeFormCubit.answerQuestion`'s own doc on why).
  final bool isLastStep;

  @override
  State<TradeFormQuestionBody> createState() => _TradeFormQuestionBodyState();
}

class _TradeFormQuestionBodyState extends State<TradeFormQuestionBody> {
  /// The live draft for an OPEN question — mirrors [_OpenAnswerField]'s own
  /// controller text, kept here too so the docked bar (a SIBLING of the
  /// scrollable body, not a descendant of the field) can gate/act on it.
  String _text = '';

  /// The live selection for a MULTI-select question (card list or
  /// searchable), in tap order — same reasoning as [_text].
  List<String> _selected = const <String>[];

  /// The live pick for a SINGLE-select question.
  String? _singleKey;

  /// The live pick for a BOOLEAN question.
  bool? _boolValue;

  @override
  void initState() {
    super.initState();
    // A fresh mount per question (the parent always supplies a new
    // `ValueKey` — see `trade_form_screen.dart`'s `_stepBody`), so seeding
    // once here from the saved answer is correct and never goes stale.
    final VoiceQuestion q = widget.step.question;
    final TradeFormSavedAnswer? answer = widget.step.answer;
    switch (q.kind) {
      case VoiceQuestionKind.open:
        // RULING D2 + D7 (#1499): a stored answer ALWAYS wins, and only when
        // there is none does a résumé FACT prefill the field. A fact is safe
        // to prefill because it is a transcription a worker can see is wrong;
        // an option key is not, which is why nothing below ever seeds a
        // selection from the suggestion.
        _text = answer?.text ?? _suggestedFactText() ?? '';
      case VoiceQuestionKind.multiSelect:
        _selected = _seedOptionKeys(answer, q.options);
      case VoiceQuestionKind.singleSelect:
        _singleKey = _seedSingleKey(answer, q.options);
      case VoiceQuestionKind.boolean:
        _boolValue =
            (answer == null || answer.isDeclined) ? null : answer.boolValue;
    }
  }

  /// The résumé's fact for this question as text, or null when it offered no
  /// fact (a chip or boolean pointer is NOT a fact — ruling D2).
  ///
  /// A number is formatted without a trailing `.0`: the server's `number` is a
  /// double on the wire, and "3.0 saal" in a field a worker is meant to confirm
  /// reads like a machine talking.
  String? _suggestedFactText() {
    final TradeFormSuggestion? s = widget.step.suggestion;
    if (s == null) return null;
    final String? text = s.text?.trim();
    if (text != null && text.isNotEmpty) return text;
    final double? number = s.number;
    if (number == null) return null;
    return number == number.roundToDouble()
        ? number.toInt().toString()
        : number.toString();
  }

  /// Option keys to HIGHLIGHT — never to tick.
  Set<String> get _suggestedKeys =>
      (widget.step.suggestion?.optionKeys ?? const <String>[]).toSet();

  bool get _canSubmit => switch (widget.step.question.kind) {
        VoiceQuestionKind.open => _text.trim().isNotEmpty,
        VoiceQuestionKind.multiSelect => _selected.isNotEmpty,
        VoiceQuestionKind.singleSelect => _singleKey != null,
        VoiceQuestionKind.boolean => _boolValue != null,
      };

  @override
  void dispose() {
    // A fresh body mounts per question, so this is also "the step changed".
    _stopSpeech();
    super.dispose();
  }

  /// What the listen button reads: the prompt, then the why text — the
  /// server's own copy on screen, never the worker's answer.
  String _speechText(VoiceQuestion q) => <String>[
        q.prompt,
        if (q.whyText != null) q.whyText!,
      ].map((String s) => s.trim()).where((String s) => s.isNotEmpty).join('\n');

  void _listen() {
    final SpeechReader? reader = widget.speechReader;
    if (reader == null) return;
    final String text = _speechText(widget.step.question);
    unawaited(() async {
      await reader.stop(); // a second tap restarts rather than overlaps
      await reader.speak(text);
    }());
  }

  void _stopSpeech() {
    final SpeechReader? reader = widget.speechReader;
    if (reader != null) unawaited(reader.stop());
  }

  void _decline() {
    _stopSpeech();
    widget.onDecline();
  }

  void _submit() {
    if (!_canSubmit) return;
    _stopSpeech();
    final VoiceQuestion q = widget.step.question;
    switch (q.kind) {
      case VoiceQuestionKind.open:
        widget.onSubmitText(_text.trim());
      case VoiceQuestionKind.multiSelect:
        widget.onSubmitChips(List<String>.of(_selected));
      case VoiceQuestionKind.singleSelect:
        widget.onSubmitChips(<String>[_singleKey!]);
      case VoiceQuestionKind.boolean:
        widget.onSubmitBoolean(_boolValue!);
    }
  }

  /// A multi-select tap. Computed from [_selected] BEFORE it is replaced —
  /// [applyNoneOfAboveRule] handles both toggle-off and the #1382 exclusion.
  void _toggleMulti(String key) {
    setState(() => _selected = applyNoneOfAboveRule(
          current: _selected,
          key: key,
          options: widget.step.question.options,
        ));
  }

  @override
  Widget build(BuildContext context) {
    final VoiceQuestion q = widget.step.question;
    // A question whose OWN options already carry a none-of-above chip
    // (#1382's `isNoneOfAbove`) offers that identical "nothing here
    // applies" declaration inside the list already — the standalone link
    // below would be a second, redundant way to say the same thing on the
    // same screen. Only ~7 of 17 CNC-turning questions carry one today (the
    // rest have no options at all, or an options set with no none-of-above
    // entry), so this check — NOT a blanket removal — is what keeps every
    // other question's only decline path intact (#1341's own "never a
    // silent skip" guarantee).
    final bool hasNoneOfAboveOption =
        q.options.any((VoiceChoice o) => o.isNoneOfAbove);
    return Column(
      children: <Widget>[
        Expanded(
          child: OnboardingBody(
            padding: const EdgeInsets.fromLTRB(
              FormFlowLayout.gutter,
              FormFlowLayout.bodyPaddingTop,
              FormFlowLayout.gutter,
              24,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text(
                  q.prompt,
                  style: OnboardingTypography.formQuestionHeadline(),
                ),
                if (q.whyText != null && q.whyText!.trim().isNotEmpty) ...<Widget>[
                  const SizedBox(height: FormFlowLayout.headlineToWhyGap),
                  _WhyText(text: q.whyText!),
                ],
                // Multi-select only (searchable multi included): a radio list
                // or a yes/no that claimed "multiple" would be a lie.
                if (q.isMultiSelect) ...<Widget>[
                  const SizedBox(height: FormFlowLayout.whyToHintGap),
                  const FormHintChip(text: kTradeFormMultiSelectHint),
                ],
                if (widget.step.hasSuggestion) ...<Widget>[
                  const SizedBox(height: 14),
                  _SuggestionConfirm(
                    // Shown even when a saved answer exists — ruling D7 says
                    // the answer wins, not that the résumé is hidden. A worker
                    // who changed his mind is entitled to see what he is
                    // disagreeing with.
                    factText: _suggestedFactText(),
                    // The chips/boolean hint needs no restatement here: it is
                    // already visible as the tagged frame on the options
                    // below, and printing an option key or a "Haan" beside
                    // them would be the same claim twice.
                  ),
                ],
                SizedBox(
                  height: q.isMultiSelect
                      ? FormFlowLayout.hintToOptionsGap
                      : FormFlowLayout.introToOptionsGap,
                ),
                IgnorePointer(
                  ignoring: !widget.enabled,
                  child: Opacity(
                    opacity: widget.enabled ? 1 : 0.5,
                    child: _body(q),
                  ),
                ),
                if (!hasNoneOfAboveOption)
                  // The same `onDecline` it always called, at a 48px target.
                  // That target centres ~17dp of text, so the link is lifted
                  // to put its text where the mockups do; the lift overlaps
                  // only the last card's outer bottom padding, never the
                  // card's own tap area.
                  Transform.translate(
                    offset: const Offset(0, -FormFlowLayout.declineLinkLift),
                    child: FormDeclineLink(
                      label: kTradeFormDeclineLabel,
                      onTap: widget.enabled ? _decline : null,
                    ),
                  ),
              ],
            ),
          ),
        ),
        QuestionnaireBottomBar(
          // #1384 item 3 — the ONE true final submit of the whole walk keeps
          // its distinct copy ("Submit karein") and drops the forward arrow;
          // every other submit reads "Aage badhein" with the arrow.
          nextLabel: widget.isLastStep ? kVoiceFinalSubmit : _kTextSubmit,
          showArrow: !widget.isLastStep,
          onNext: (widget.enabled && _canSubmit) ? _submit : null,
          onListen: widget.speechReader == null ? null : _listen,
          variant: OnboardingVariant.formFlow,
        ),
      ],
    );
  }

  Widget _body(VoiceQuestion q) {
    if (q.kind == VoiceQuestionKind.open) {
      // "Abhi aap kaunse sheher mein hain?" reaches the form only when /name
      // did not save a city (see `dedupeTradeForm`). Ask it with /name's own
      // State → City pickers, never a plain text box.
      if (q.id == kTradeFormCurrentCityQuestionKey) {
        return _CityPickerAnswer(
          key: ValueKey<String>('${q.id}-city'),
          initialCity: widget.step.answer?.text ?? _suggestedFactText(),
          onChanged: (String v) => setState(() => _text = v),
        );
      }
      return _OpenAnswerField(
        key: ValueKey<String>('${q.id}-text'),
        // #1382 — a saved `text` answer pre-fills the field so a worker who
        // navigates back to an answered question does not see it blank.
        // Boolean/number answers never reach this branch (`answer_type` maps
        // them to `boolean`/never ships `number` — see `VoiceQuestionKind`'s
        // `_kind` mapping), so `text` is the only field this widget renders.
        // #1499 — a résumé FACT prefills ONLY when nothing is stored; the
        // stored answer always wins (ruling D7), exactly as `initState` seeds
        // `_text`. The two must agree or the field and the submit gate
        // disagree about what is in it.
        initialText: widget.step.answer?.text ?? _suggestedFactText(),
        onChanged: (String v) => setState(() => _text = v),
        onSubmitPressed: _submit,
      );
    }
    if (widget.step.searchable) {
      return _SearchableOptionList(
        key: ValueKey<String>('${q.id}-searchable'),
        options: q.options,
        // Never filter away a pick, nor a résumé's hint: a hint the worker
        // cannot find is not a hint.
        isPinned: (String key) =>
            _selected.contains(key) ||
            _singleKey == key ||
            _suggestedKeys.contains(key),
        buildCard: (VoiceChoice c) => _optionCard(q, c),
      );
    }
    if (q.isBoolean) {
      final bool? hint = widget.step.suggestion?.boolValue;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _suggestable(
            // #1499 — a yes/no on these packs is a capability claim ("kya
            // aap drawing padh sakte hain"), so its hint is HIGHLIGHTED BUT
            // UNPICKED for exactly the reason an option key's is.
            suggested: hint == true,
            card: SingleSelectQuestionCard(
              title: kVoiceBooleanYes,
              leadingIcon: iconForOption(
                optionKey: 'yes',
                label: kVoiceBooleanYes,
                questionKey: q.id,
              ),
              isSelected: _boolValue == true,
              onTap: () => setState(() => _boolValue = true),
              variant: OnboardingVariant.formFlow,
            ),
          ),
          _suggestable(
            suggested: hint == false,
            card: SingleSelectQuestionCard(
              title: kVoiceBooleanNo,
              leadingIcon: iconForOption(
                optionKey: 'no',
                label: kVoiceBooleanNo,
                questionKey: q.id,
              ),
              isSelected: _boolValue == false,
              onTap: () => setState(() => _boolValue = false),
              variant: OnboardingVariant.formFlow,
            ),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final VoiceChoice c in q.options) _optionCard(q, c),
      ],
    );
  }

  /// One option as a kit card.
  ///
  /// #1499, RULING D2 — HIGHLIGHTED, NEVER TICKED. Whether the résumé pointed
  /// at [c] decides ONLY the frame around the card ([TradeFormSuggestedOption]);
  /// `isSelected` reads the worker's own [_selected]/[_singleKey] and nothing
  /// else. Merging the two is the one-line change that would put a capability
  /// on a man's profile that he never claimed, because a screen that already
  /// looks answered gets submitted unread.
  Widget _optionCard(VoiceQuestion q, VoiceChoice c) {
    // Derived from the option's own words, never a per-key table — see
    // `option_icons.dart`. Decoration only: it changes nothing about the pick.
    final IconData icon = iconForOption(
      optionKey: c.key,
      label: c.label,
      questionKey: q.id,
    );
    // Screen 8 draws the tenure rungs as career tiers. Display only: the key
    // this card submits and the pack's gating number are untouched.
    final TenureTierLabel? tier =
        tenureTierLabelFor(questionKey: q.id, optionKey: c.key);
    final Widget card = q.isMultiSelect
        ? MultiSelectQuestionCard(
            title: c.label,
            leadingIcon: icon,
            // #1382/#1384 — a saved multi-select answer arrives pre-ticked
            // (see `_seedOptionKeys` for the declined/none-of-above case).
            isSelected: _selected.contains(c.key),
            onTap: () => _toggleMulti(c.key),
            variant: OnboardingVariant.formFlow,
          )
        : SingleSelectQuestionCard(
            title: tier?.title ?? c.label,
            subtitle: tier?.description,
            leadingIcon: icon,
            isSelected: _singleKey == c.key,
            onTap: () => setState(() => _singleKey = c.key),
            variant: OnboardingVariant.formFlow,
          );
    return _suggestable(suggested: _suggestedKeys.contains(c.key), card: card);
  }

  Widget _suggestable({required bool suggested, required Widget card}) =>
      suggested ? TradeFormSuggestedOption(child: card) : card;
}

/// #1384 item 2 — the pre-fill seed for a saved answer's option keys.
///
/// A saved answer with [TradeFormSavedAnswer.isDeclined] is a REAL, SETTLED
/// choice ("nothing here applies"), not silence — see the doc on
/// [TradeFormAnswerStatus.declined] (`trade_form_models.dart`): it covers
/// BOTH the explicit "Pata nahi" decline AND a multi-select where the worker
/// tapped the none-of-above chip, which the server ALSO records as a
/// declined save with an empty `option_keys`. Re-seeding blank in that case
/// would render the none-of-above option unselected — indistinguishable from
/// a genuinely untouched question. So: when [answer] is declined AND the
/// question offers a none-of-above option, seed THAT option's key. A
/// question with no none-of-above option (or a genuinely-answered save) has
/// nothing special to do and falls back to the raw saved [optionKeys].
List<String> _seedOptionKeys(
  TradeFormSavedAnswer? answer,
  List<VoiceChoice> options,
) {
  if (answer == null) return const <String>[];
  if (!answer.isDeclined) return answer.optionKeys;
  for (final VoiceChoice option in options) {
    if (option.isNoneOfAbove) return <String>[option.key];
  }
  return answer.optionKeys;
}

/// The saved pick for a single-select question, via [_seedOptionKeys] — but
/// only a key the question actually OFFERS. A radio pre-selected on a key no
/// card shows would enable "Aage badhein" on a choice the worker cannot see.
String? _seedSingleKey(
  TradeFormSavedAnswer? answer,
  List<VoiceChoice> options,
) {
  final Set<String> offered = options.map((VoiceChoice o) => o.key).toSet();
  for (final String key in _seedOptionKeys(answer, options)) {
    if (offered.contains(key)) return key;
  }
  return null;
}

/// #1499, ruling D2 — the frame around an option card an uploaded résumé
/// pointed at: a soft BLUE tint with a "Resume mein tha" tag.
///
/// Deliberately distinct from BOTH other states — a plain card has no frame,
/// and a selected card is yellow — so a hint can never be mistaken for a tick.
/// It never changes the card inside it: a card that is both picked and hinted
/// (ruling D7) paints SELECTED within the frame.
class TradeFormSuggestedOption extends StatelessWidget {
  const TradeFormSuggestedOption({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Container(
        // No bottom padding: the kit card carries its own 10px bottom gap.
        padding: const EdgeInsets.fromLTRB(6, 6, 6, 0),
        decoration: BoxDecoration(
          color: OnboardingColors.shieldCircle,
          borderRadius: BorderRadius.circular(OnboardingRadii.card + 2),
          border: Border.all(
            color: OnboardingColors.shiftBlueLight.withValues(alpha: 0.35),
            width: 1.2,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Padding(
              padding: const EdgeInsets.fromLTRB(6, 2, 6, 6),
              child: Row(
                children: <Widget>[
                  const Icon(
                    Icons.description_outlined,
                    size: 14,
                    color: OnboardingColors.shiftBlue,
                  ),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      kTradeFormSuggestedTag,
                      style: OnboardingTypography.inter(
                        size: 11,
                        weight: FontWeight.w700,
                        letterSpacing: 0.3,
                        color: OnboardingColors.shiftBlue,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            child,
          ],
        ),
      ),
    );
  }
}

/// #1499 — the résumé's contribution, introduced honestly and as a QUESTION.
///
/// It is a banner rather than a badge on the field because a worker has to
/// understand WHY something he did not type is sitting in front of him before
/// he can sensibly agree or disagree with it. [factText] is shown when the
/// résumé offered a fact; for a chip or boolean hint the banner carries the
/// line alone and the tagged option below is the "ye".
///
/// The confidence number is deliberately absent: it is observability, not copy.
/// A percentage on screen invites a worker to argue with a number instead of
/// answering the question.
class _SuggestionConfirm extends StatelessWidget {
  const _SuggestionConfirm({this.factText});

  final String? factText;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: OnboardingColors.shieldCircle,
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        // Hairline, never a shadow.
        border: Border.all(
          color: OnboardingColors.shiftBlueLight.withValues(alpha: 0.35),
          width: 1.2,
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(
            Icons.description_outlined,
            size: 18,
            color: OnboardingColors.shiftBlue,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  _kSuggestionConfirm,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w700,
                  ),
                ),
                if (factText != null && factText!.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 4),
                  Text(factText!, style: OnboardingTypography.body()),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _WhyText extends StatelessWidget {
  const _WhyText({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: '$_kWhyLabel: $text',
      child: Text(text, style: OnboardingTypography.formWhyText()),
    );
  }
}

/// The `ui.searchable == true` branch: a kit search box over the question's
/// option cards. It owns ONLY the query; the selection lives in
/// [TradeFormQuestionBody] (see its class doc), which builds every card via
/// [buildCard]. A fresh `ValueKey` per question means a query typed against
/// one question never filters the next.
class _SearchableOptionList extends StatefulWidget {
  const _SearchableOptionList({
    super.key,
    required this.options,
    required this.isPinned,
    required this.buildCard,
  });

  /// The full option list (unfiltered). Order is preserved — never re-sorted
  /// by selection or match quality.
  final List<VoiceChoice> options;

  /// True for an option the search must never hide: a pick, or a résumé hint.
  final bool Function(String key) isPinned;

  final Widget Function(VoiceChoice option) buildCard;

  @override
  State<_SearchableOptionList> createState() => _SearchableOptionListState();
}

class _SearchableOptionListState extends State<_SearchableOptionList> {
  final TextEditingController _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final String q = _query.trim().toLowerCase();
    final List<VoiceChoice> visible = widget.options
        .where((VoiceChoice o) =>
            widget.isPinned(o.key) ||
            q.isEmpty ||
            o.label.toLowerCase().contains(q))
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(
          label: _kSearchLabel,
          textField: true,
          child: TextField(
            controller: _search,
            onChanged: (String value) => setState(() => _query = value),
            textInputAction: TextInputAction.search,
            cursorColor: OnboardingColors.shiftBlue,
            style: OnboardingTypography.inter(size: 14, weight: FontWeight.w500),
            decoration: tradeFormInputDecoration(
              hint: _kSearchHint,
              prefixIcon: const Icon(
                Icons.search_rounded,
                color: OnboardingColors.ink600,
              ),
            ),
          ),
        ),
        const SizedBox(height: 12),
        if (visible.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(_kSearchEmpty, style: OnboardingTypography.bodyMuted()),
          )
        else
          for (final VoiceChoice option in visible) widget.buildCard(option),
      ],
    );
  }
}

/// The `open` branch (`text`/`number` `answer_type`) — a plain text field;
/// no option cards apply since these questions ship no options. The submit
/// button lives in the PARENT's docked bar — this widget only reports its
/// live text up via [onChanged], plus [onSubmitPressed] for the keyboard's own
/// "Done" action.
class _OpenAnswerField extends StatefulWidget {
  const _OpenAnswerField({
    super.key,
    required this.onChanged,
    required this.onSubmitPressed,
    this.initialText,
  });

  /// Reports the live (untrimmed) text up on every keystroke.
  final ValueChanged<String> onChanged;

  /// The keyboard's "Done" action — mirrors tapping the docked submit button.
  final VoidCallback onSubmitPressed;

  /// A saved `text` answer to pre-fill (#1382) — null/omitted starts empty,
  /// today's behaviour.
  final String? initialText;

  @override
  State<_OpenAnswerField> createState() => _OpenAnswerFieldState();
}

class _OpenAnswerFieldState extends State<_OpenAnswerField> {
  // Same seed-from-widget-on-construction shape `_EmployerCardState` already
  // uses for its own text controllers (`trade_form_employment_page.dart`).
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialText ?? '')
        ..addListener(() => widget.onChanged(_controller.text));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TradeFormTextField(
      controller: _controller,
      hint: _kTextHint,
      maxLines: 3,
      textInputAction: TextInputAction.done,
      onSubmitted: (_) => widget.onSubmitPressed(),
    );
  }
}

/// The current-city question as the SAME State → City pickers /name uses
/// ([kIndianStates], [citiesForIndianState], a typed city allowed): a worker
/// who skipped the city on /name is asked it here once, in the shape they
/// already know. Reports the chosen city (or `''` while none) as the text
/// answer.
class _CityPickerAnswer extends StatefulWidget {
  const _CityPickerAnswer({
    super.key,
    required this.onChanged,
    this.initialCity,
  });

  final ValueChanged<String> onChanged;

  /// A saved answer or a résumé fact to show first, as the text field did.
  final String? initialCity;

  @override
  State<_CityPickerAnswer> createState() => _CityPickerAnswerState();
}

class _CityPickerAnswerState extends State<_CityPickerAnswer> {
  String _state = '';
  late String _city = widget.initialCity?.trim() ?? '';

  /// STATE first (state always precedes city). A different state clears the
  /// city chosen under the old one.
  Future<void> _pickState() async {
    final String? picked = await showOnboardingPicker(
      context,
      title: _kCityStateSheetTitle,
      options: kIndianStates,
      selected: _state.isEmpty ? null : _state,
    );
    if (!mounted || picked == null || picked == _state) return;
    setState(() {
      _state = picked;
      _city = '';
    });
    widget.onChanged('');
  }

  /// CITY second. The list is a suggestion, never a gate: whatever the worker
  /// types can be used as-is, as on /name.
  Future<void> _pickCity() async {
    final String? picked = await showOnboardingPicker(
      context,
      title: _kCityCitySheetTitle,
      options: citiesForIndianState(_state),
      selected: _city.isEmpty ? null : _city,
      allowCustom: true,
      customMaxLength: _kMaxCityLength,
    );
    if (!mounted || picked == null) return;
    setState(() => _city = picked.trim());
    widget.onChanged(_city);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const TradeFormFieldLabel(_kCityStateLabel),
        OnboardingSelectField(
          value: _state,
          hint: _kCityStateHint,
          semanticLabel: _kCityStateLabel,
          onTap: _pickState,
        ),
        const SizedBox(height: 14),
        const TradeFormFieldLabel(_kCityCityLabel),
        OnboardingSelectField(
          value: _city,
          hint: _kCityCityHint,
          semanticLabel: _kCityCityLabel,
          enabled: _state.isNotEmpty,
          onTap: _pickCity,
        ),
      ],
    );
  }
}
