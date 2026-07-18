import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
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

  /// True from the tap on "Done — build my profile" until the pushed preview
  /// comes back. #372 — the push used to be unguarded, and ProfilePreviewScreen
  /// builds a FRESH ProfileCubit that fires `extract()` on every mount: a
  /// double-tap (routine on the low-end devices we target) stacked two preview
  /// screens AND enqueued two concurrent extraction AI jobs — duplicate real
  /// spend per §COST, plus a second spinner on back that reads as the app
  /// looping.
  bool _openingPreview = false;

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

  /// Smooth-scroll to the newest message after the list has rebuilt.
  ///
  /// A freshly-appended bubble can still be growing the list's
  /// `maxScrollExtent` on the frame we kick the animation off, so the captured
  /// target lands a few pixels short of the true bottom. We animate to the
  /// best-known extent, then on completion re-check and snap the residual gap
  /// so the newest message is always fully in view.
  void _animateToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!_scroll.hasClients) return;
      await _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: AppMotion.base,
        curve: AppMotion.easeOut,
      );
      if (!_scroll.hasClients) return;
      final double end = _scroll.position.maxScrollExtent;
      if (_scroll.position.pixels < end) {
        _scroll.jumpTo(end);
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
    ));
  }

  /// Opens the profile preview at most once per round trip (#372).
  ///
  /// The boolean is checked SYNCHRONOUSLY, before the frame that disables the
  /// button paints: a real double-tap lands both taps inside the same frame, so
  /// the disabled state alone would arrive too late to stop the second push.
  Future<void> _openProfilePreview() async {
    if (_openingPreview) return;
    setState(() => _openingPreview = true);
    try {
      await context.push(Routes.profilePreview);
    } finally {
      // Confirming the profile leaves via `go(/building)` — this screen is gone
      // by then, hence the mounted check before re-arming the button.
      if (mounted) setState(() => _openingPreview = false);
    }
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
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                        AppSpacing.s4, 0, AppSpacing.s4, AppSpacing.s4),
                    child: BbButton(
                      label: 'Done — build my profile',
                      block: true,
                      iconLeft: Icons.check_circle_outline,
                      // Disabled for the whole round trip (#372) — the visible
                      // half of the guard; `_openProfilePreview` holds the
                      // same-frame half.
                      onPressed:
                          _openingPreview ? null : _openProfilePreview,
                    ),
                  ),
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
