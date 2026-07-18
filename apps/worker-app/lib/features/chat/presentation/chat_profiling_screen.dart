import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chat_bubble.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../router.dart';
import '../../voice/domain/voice_models.dart';
import '../domain/chat_message.dart';
import 'bloc/chat_bloc.dart';

/// How close to the bottom (px) the worker must be for a freshly-received bot
/// message to auto-scroll. Beyond this, we surface the "new message" pill
/// instead of yanking the transcript down under their thumb.
const double _kNearBottomThreshold = 120;

/// Hinglish label on the jump-to-bottom pill.
const String _kNewMessageLabel = 'Naye message';

/// Banner copy when the chat session could not be opened (#343). Honest about
/// the cause: the connection was not established, and sending retries it.
const String _kSessionFailedLabel =
    'Server se connection nahi bana — message bhejenge to dobara try hoga.';

// ---------------------------------------------------------------------------
// #421 — readiness copy for the "build my profile" CTA.
//
// The engine decides when it has enough to build a profile (`extraction_ready`).
// Before that, the CTA is SOFTENED, never dead: it keeps its ≥48px tap target
// and stays tappable, and tapping it opens a warm sheet that explains what is
// missing and offers BOTH "keep talking" and "build it anyway". A hard-disabled
// button with no explanation would be worse than the bug for a first-time,
// low-literacy worker — and a client-side gate must never be able to trap a
// worker in a chat they cannot leave.
// ---------------------------------------------------------------------------

/// CTA label once the engine says the interview is complete.
const String kChatDoneReadyLabel = 'Ho gaya — meri profile banaiye';

/// CTA label while the interview is still short — an invitation, not a block.
const String kChatDoneNotReadyLabel = 'Thodi aur baat karein';

/// Helper line under the transcript while the interview is still short.
///
/// Deliberately NAMES NO TOPICS. The chat reply carries only `asked_question_id`
/// and `extraction_ready` — there is no missing-topics field, so the client
/// CANNOT know what is actually blocking readiness and must not pretend to.
///
/// An earlier draft read "kaam, machine aur experience bata dijiye". That was a
/// lie with a concrete victim: a worker who has already answered role, machines
/// and experience but not, say, `current_location` is still not ready — and the
/// app would tell them to state the exact three things they just said. A
/// low-literacy worker reads that as "it did not hear me", repeats themselves,
/// and still does not get ready. The list was also stale as of #429, which added
/// salary_current / salary_expected / availability to the readiness bar.
///
/// Naming the real gaps needs a `missing_essentials` field on the chat reply —
/// backend work, deliberately out of scope here.
const String kChatNotReadyHelper =
    'Do-teen sawaal aur baaki hain — bas jawab dete rahiye, profile utni hi '
    'dumdaar banegi.';

/// Nudge-sheet heading.
const String kChatNudgeTitle = 'Ek minute, bhai';

/// Nudge-sheet body — honest about the cost of stopping now.
const String kChatNudgeBody =
    'Aap abhi profile bana sakte hain, par woh adhoori rahegi. Thodi baat aur '
    'ho jaye to company ko aapki poori baat dikhegi.';

/// Nudge-sheet primary action — back to the chat.
const String kChatNudgeContinueLabel = 'Baat jaari rakhein';

/// Nudge-sheet escape hatch — the worker is never trapped.
const String kChatNudgeProceedLabel = 'Phir bhi profile banaiye';

class ChatProfilingScreen extends StatelessWidget {
  const ChatProfilingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ChatBloc>(
      create: (_) => locator<ChatBloc>()..add(const ChatStarted()),
      child: const _ChatView(),
    );
  }
}

class _ChatView extends StatefulWidget {
  const _ChatView();

  @override
  State<_ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<_ChatView> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scroll = ScrollController();

  /// True when a bot message arrived while the worker had scrolled up — drives
  /// the "Naye message" jump pill rather than yanking the transcript down.
  bool _hasUnreadBelow = false;

  @override
  void initState() {
    super.initState();
    // Manual scroll back near the bottom dismisses the pill.
    _scroll.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final String text = _controller.text;
    if (text.trim().isEmpty) return;
    _sendText(text);
    _controller.clear();
  }

  /// Send an answer from a tap-to-answer chip — same path as typing it.
  void _sendText(String text) {
    if (text.trim().isEmpty) return;
    context.read<ChatBloc>().add(ChatMessageSent(text));
  }

  /// Re-send the failed bubble at [index] (#343) — in place, no duplicate.
  void _retry(int index) {
    context.read<ChatBloc>().add(ChatRetryRequested(index));
  }

  /// Whether the viewport is within [_kNearBottomThreshold] of the end.
  bool get _isNearBottom {
    if (!_scroll.hasClients) return true;
    final ScrollPosition pos = _scroll.position;
    return pos.pixels >= pos.maxScrollExtent - _kNearBottomThreshold;
  }

  /// How many measure-and-jump passes [_animateToBottom] may take to settle.
  ///
  /// One is not enough once bubble heights VARY. A `ListView.builder` only
  /// ESTIMATES `maxScrollExtent` from the items it has currently laid out, so
  /// when the worker is scrolled UP — the multi-line opener on screen, the
  /// one-line answers below it unbuilt — the estimate is inflated. The
  /// animation then targets that inflated figure, overshoots the true end, and
  /// the old single corrective jump measured against a value that was itself
  /// still stale, leaving the transcript parked past its last bubble in blank
  /// space with nothing to scroll it back.
  ///
  /// MEASURED (400x700, `_kChatOpeningText` as the first bubble, one-word
  /// replies, worker scrolled to the top before the reply lands):
  ///
  ///   |  turns |  pixels |     max | overshoot |
  ///   |--------|---------|---------|-----------|
  ///   |      6 |   881.7 |   857.0 |     +24.7 |
  ///   |     12 |  1949.7 |  1589.0 |    +360.7 |
  ///   |     20 |  3373.8 |  2565.0 |    +808.8 |
  ///
  /// It is zero in every one of those fixtures when the worker is already AT
  /// the bottom (the estimate is then formed from the short bubbles), and zero
  /// with a single-line opener — which is why this only became reachable when
  /// the opener grew (#422), and why it is fixed in that same change.
  ///
  /// Each jump forces a layout pass, which sharpens the estimate, so a few
  /// bounded passes converge. Bounded so it can never spin.
  static const int _kBottomSettleSteps = 5;

  /// Smooth-scroll to the newest message after the list has rebuilt.
  ///
  /// A freshly-appended bubble can still be growing the list's
  /// `maxScrollExtent` on the frame we kick the animation off, so the captured
  /// target misses the true bottom in either direction. We animate to the
  /// best-known extent, then converge on the real one (see
  /// [_kBottomSettleSteps]) so the newest message is always fully in view.
  void _animateToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!_scroll.hasClients) return;
      await _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: AppMotion.base,
        curve: AppMotion.easeOut,
      );
      // Re-measure and re-jump until pixels and the reported end agree (or the
      // step budget runs out — never loop on a list that will not settle).
      for (int step = 0; step < _kBottomSettleSteps; step++) {
        if (!mounted || !_scroll.hasClients) return;
        final double end = _scroll.position.maxScrollExtent;
        if ((_scroll.position.pixels - end).abs() < 0.5) return;
        // Also corrects an OVERSHOOT (pixels beyond the true end), which left
        // the transcript parked past its last bubble in empty space.
        _scroll.jumpTo(end);
        await WidgetsBinding.instance.endOfFrame;
      }
    });
  }

  /// Clear the unread pill once the worker has scrolled back near the bottom.
  void _onScroll() {
    if (_hasUnreadBelow && _isNearBottom) {
      setState(() => _hasUnreadBelow = false);
    }
  }

  /// Decide how to react to a freshly-appended message.
  void _onMessagesChanged(List<ChatMessage> messages) {
    if (messages.isEmpty) return;
    final bool ownMessage = messages.last.fromWorker;
    if (ownMessage || _isNearBottom) {
      // Own message always follows the worker down; a received one only when
      // they were already reading the bottom.
      if (_hasUnreadBelow) setState(() => _hasUnreadBelow = false);
      _animateToBottom();
    } else {
      // Received while scrolled up — surface the pill instead of jumping.
      setState(() => _hasUnreadBelow = true);
    }
  }

  void _jumpToBottom() {
    _animateToBottom();
    setState(() => _hasUnreadBelow = false);
  }

  /// Opens the voice-note screen and, when it pops with a completed
  /// [VoiceNoteOutcome], appends the transcript + reply bubbles. The pipeline
  /// already sent the transcript server-side, so this is a LOCAL append only
  /// (see [ChatVoiceMerged]).
  Future<void> _openVoiceNote() async {
    final ChatBloc bloc = context.read<ChatBloc>();
    final VoiceNoteOutcome? outcome =
        await context.push<VoiceNoteOutcome>(Routes.voiceNote);
    if (outcome == null) return;
    bloc.add(ChatVoiceMerged(
      transcript: outcome.transcript,
      reply: outcome.reply,
      // A voice answer is a normal chat turn server-side, so it carries the
      // engine's readiness decision too (#421).
      extractionReady: outcome.extractionReady,
    ));
  }

  /// The "build my profile" CTA + (when the interview is still short) the
  /// helper line above it (#421).
  ///
  /// Not-ready is a SOFT gate: the button keeps its full-width ≥48px target and
  /// stays tappable — it just changes voice from "done" to "let's talk a bit
  /// more", and routes through [_confirmEarlyFinish] instead of straight to the
  /// preview. Nothing here can leave the worker stuck.
  Widget _doneCta(bool ready) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.s4, 0, AppSpacing.s4, AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (!ready) ...<Widget>[
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.s2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Padding(
                    padding: EdgeInsets.only(top: 2),
                    child: Icon(Icons.chat_bubble_outline,
                        size: 18, color: AppColors.textSecondary),
                  ),
                  const SizedBox(width: AppSpacing.s2),
                  Expanded(
                    child: Text(
                      kChatNotReadyHelper,
                      style: AppTypography.body(
                        size: AppTypography.sizeBase,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
          BbButton(
            label: ready ? kChatDoneReadyLabel : kChatDoneNotReadyLabel,
            block: true,
            variant:
                ready ? BbButtonVariant.primary : BbButtonVariant.secondary,
            iconLeft: ready ? Icons.check_circle_outline : Icons.forum_outlined,
            onPressed: ready ? _openProfilePreview : _confirmEarlyFinish,
          ),
        ],
      ),
    );
  }

  void _openProfilePreview() => context.push(Routes.profilePreview);

  /// Warm nudge when the engine has not called the interview complete yet.
  ///
  /// Explains WHY in one plain Hinglish line and offers both ways out: keep
  /// talking (the default, primary) or build the profile anyway. The escape
  /// hatch is deliberate — the client must never be the reason a worker cannot
  /// finish (e.g. if `extraction_ready` were missing from a reply, which the
  /// parser reads as "not ready").
  Future<void> _confirmEarlyFinish() async {
    final bool? proceed = await showBbBottomSheet<bool>(
      context: context,
      builder: (BuildContext sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            kChatNudgeTitle,
            style: AppTypography.display(size: AppTypography.sizeLg),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            kChatNudgeBody,
            style: AppTypography.body(
              size: AppTypography.sizeBase,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          BbButton(
            label: kChatNudgeContinueLabel,
            block: true,
            onPressed: () => Navigator.of(sheetContext).pop(false),
          ),
          const SizedBox(height: AppSpacing.s2),
          BbButton(
            label: kChatNudgeProceedLabel,
            block: true,
            variant: BbButtonVariant.ghost,
            onPressed: () => Navigator.of(sheetContext).pop(true),
          ),
        ],
      ),
    );
    if (proceed != true) return;
    if (!mounted) return;
    _openProfilePreview();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: BbAppBar(
        title: 'Profiling',
        actions: <Widget>[
          IconButton(
            tooltip: 'Voice note bhejein',
            icon: const Icon(Icons.mic_none, color: AppColors.brand),
            onPressed: _openVoiceNote,
          ),
        ],
      ),
      body: BlocListener<ChatBloc, ChatState>(
        // Fire only when a message is appended (length grows), not on every
        // state change (e.g. the initializing flag flipping).
        listenWhen: (ChatState prev, ChatState curr) =>
            curr.messages.length > prev.messages.length,
        listener: (BuildContext context, ChatState state) =>
            _onMessagesChanged(state.messages),
        child: BlocBuilder<ChatBloc, ChatState>(
          builder: (BuildContext context, ChatState state) {
            if (state.initializing) {
              return const Center(child: CircularProgressIndicator());
            }
            return SafeArea(
              child: Column(
                children: <Widget>[
                  if (state.sessionFailed) _sessionBanner(),
                  Expanded(
                    child: Stack(
                      children: <Widget>[
                        ListView.builder(
                          controller: _scroll,
                          padding: const EdgeInsets.all(AppSpacing.s4),
                          itemCount: state.messages.length,
                          itemBuilder: (BuildContext context, int i) {
                            final ChatMessage m = state.messages[i];
                            final bool failed =
                                m.status == ChatSendStatus.failed;
                            return BbChatBubble(
                              text: m.text,
                              fromWorker: m.fromWorker,
                              failed: failed,
                              onRetry: failed ? () => _retry(i) : null,
                            );
                          },
                        ),
                        if (_hasUnreadBelow)
                          Positioned(
                            left: 0,
                            right: 0,
                            bottom: AppSpacing.s3,
                            child: Center(child: _jumpPill()),
                          ),
                      ],
                    ),
                  ),
                  if (state.sending)
                    _typingIndicator()
                  else if (state.followups.isNotEmpty)
                    _followups(state.followups),
                  _inputBar(),
                  _doneCta(state.extractionReady),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _inputBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextField(
              controller: _controller,
              minLines: 1,
              maxLines: 4,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => _send(),
              decoration: const InputDecoration(hintText: 'Type your answer…'),
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          Material(
            color: AppColors.success,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: _send,
              child: const SizedBox(
                width: AppSpacing.tap,
                height: AppSpacing.tap,
                child: Icon(Icons.send_rounded,
                    color: AppColors.textOnBrand, size: 22),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Shown when the chat session could not be opened (#343).
  ///
  /// The failure used to be swallowed entirely: the worker typed answer after
  /// answer into a session that was never opened, saw no error, and only found
  /// out when their profile came out empty. The next send re-opens the session
  /// lazily, so this states the real cause and what to do — no false blame on
  /// the worker's internet, and no fake "sent" impression.
  Widget _sessionBanner() {
    return Container(
      width: double.infinity,
      color: AppColors.red50,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.cloud_off, size: 18, color: AppColors.red600),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              _kSessionFailedLabel,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.red600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// "Bada Bhai type kar raha hai…" — shown while a reply is in flight so a
  /// real (1–3s) LLM turn does not look frozen.
  ///
  /// Deliberately STATIC (a dots glyph, not a spinning `CircularProgressIndicator`):
  /// an indefinite animation never lets `WidgetTester.pumpAndSettle` settle, and
  /// the value here is the honest "still working" cue, not motion.
  Widget _typingIndicator() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.s4, AppSpacing.s1, AppSpacing.s4, AppSpacing.s2),
      child: Row(
        children: <Widget>[
          const Icon(Icons.more_horiz, size: 20, color: AppColors.brand),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              'Bada Bhai type kar raha hai…',
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Tap-to-answer chips from the backend's `suggested_followups`. Tapping one
  /// sends it exactly like a typed answer — so a worker who cannot type quickly
  /// can still answer. Horizontally scrollable so long suggestions never clip.
  Widget _followups(List<String> followups) {
    return Container(
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.s4, AppSpacing.s1, AppSpacing.s4, AppSpacing.s2),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: <Widget>[
            for (final String f in followups) ...<Widget>[
              BbChip(label: f, onTap: () => _sendText(f)),
              const SizedBox(width: AppSpacing.s2),
            ],
          ],
        ),
      ),
    );
  }

  /// "Naye message" jump pill — shown bottom-centre above the composer when a
  /// bot reply lands while the worker has scrolled up. Tapping rides them down.
  Widget _jumpPill() {
    return Material(
      color: AppColors.surfaceCard,
      elevation: 3,
      borderRadius: BorderRadius.circular(AppRadii.pill),
      shadowColor: AppColors.scrim,
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadii.pill),
        onTap: _jumpToBottom,
        child: Container(
          constraints: const BoxConstraints(minHeight: AppSpacing.tap),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.s4,
            vertical: AppSpacing.s2,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                _kNewMessageLabel,
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                  color: AppColors.brand,
                ),
              ),
              const SizedBox(width: AppSpacing.s1),
              const Icon(Icons.keyboard_arrow_down_rounded,
                  color: AppColors.brand, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}
