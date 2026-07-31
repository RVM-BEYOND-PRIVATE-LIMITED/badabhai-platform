import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_chat_bubble.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_toast.dart';
import '../domain/chat_message.dart';
import 'bloc/job_posting_chat_bloc.dart';
import 'widgets/draft_preview.dart';

/// Banner copy when the chat session could not be opened. Honest about the
/// cause: the connection was not established, and sending retries it.
const String kJobChatSessionFailedLabel =
    'Could not reach the server — sending a message will try again.';

/// Shown when a turn was BLOCKED (pseudonymization failed closed, invariant #3):
/// the payer's last answer was NOT processed, so say so plainly rather than let
/// a canned fallback reply read as "understood".
const String kJobChatBlockedNotice =
    'That did not go through — please rephrase it and send again.';

const String kJobChatTypingLabel = 'Working on it…';

const String kJobChatTitle = 'AI job posting';

/// The AI-assisted job-posting chat (ADR-0035).
///
/// The payer answers a DETERMINISTIC interview (topic bank + ordering + ask
/// bounds live server-side; the LLM only rephrases — invariant #4), and the
/// server builds a `JobPostingDraft`. Nothing is created until the payer taps
/// Publish, which validates that draft against the SAME
/// `PayerCreateJobPostingSchema` the manual form uses and calls the SAME
/// `createForPayer` path.
///
/// The chat NEVER asks for the payer's company/org name and there is no field
/// for it anywhere in this screen — it is auto-filled server-side at publish
/// time (§Decision 3).
///
/// [resumeSessionId] is the CROSS-DEVICE pickup: pass the id from
/// `GET /payer/job-posting-chat/sessions` and this screen binds that existing
/// conversation and hydrates its transcript instead of starting a new one.
class JobPostingChatScreen extends StatelessWidget {
  const JobPostingChatScreen({
    super.key,
    required this.onBack,
    this.resumeSessionId,
    this.onPublished,
  });

  final VoidCallback onBack;
  final String? resumeSessionId;

  /// Called after a posting is created, so the host can refresh My-jobs.
  final VoidCallback? onPublished;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<JobPostingChatBloc>(
      create: (_) => locator<JobPostingChatBloc>()
        ..add(JobPostingChatStarted(resumeSessionId: resumeSessionId)),
      child: _ChatView(onBack: onBack, onPublished: onPublished),
    );
  }
}

class _ChatView extends StatefulWidget {
  const _ChatView({required this.onBack, this.onPublished});

  final VoidCallback onBack;
  final VoidCallback? onPublished;

  @override
  State<_ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<_ChatView> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scroll = ScrollController();

  /// True once the payer has opened the structured draft panel. It also opens
  /// itself the first time the engine reports the draft ready.
  bool _draftOpen = false;
  bool _autoOpenedDraft = false;

  @override
  void dispose() {
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

  /// Send an answer from a tap-to-answer chip — the same path as typing it.
  ///
  /// THE CHIP LABEL BECOMES THE PAYER'S ANSWER OF RECORD, verbatim. Nothing here
  /// rewrites or filters it; if a chip is ever wrong, the fix belongs in the
  /// server-side question bank, not in this widget.
  void _sendText(String text) {
    if (text.trim().isEmpty) return;
    context.read<JobPostingChatBloc>().add(JobPostingChatMessageSent(text));
  }

  void _retry(int index) {
    context.read<JobPostingChatBloc>().add(JobPostingChatRetryRequested(index));
  }

  void _publish() {
    context.read<JobPostingChatBloc>().add(const JobPostingChatPublishRequested());
  }

  void _animateToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!_scroll.hasClients) return;
      await _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: AppMotion.base,
        curve: AppMotion.easeOut,
      );
      // A freshly-appended bubble can still be growing maxScrollExtent on the
      // frame the animation starts, so converge on the real end in a few bounded
      // passes rather than parking short of (or past) the newest message.
      for (int step = 0; step < 5; step++) {
        if (!mounted || !_scroll.hasClients) return;
        final double end = _scroll.position.maxScrollExtent;
        if ((_scroll.position.pixels - end).abs() < 0.5) return;
        _scroll.jumpTo(end);
        await WidgetsBinding.instance.endOfFrame;
      }
    });
  }

  /// Surfaces the one-shot publish result and, on success, hands control back to
  /// the host (refresh My-jobs + close).
  void _onPublishOutcome(BuildContext context, JobPostingChatState state) {
    final (String title, String message, IconData icon) =
        switch (state.publishOutcome) {
      PublishOutcome.success => (
          'Posted',
          'Your job posting was created as a draft — publish it from My jobs.',
          Icons.check_circle,
        ),
      PublishOutcome.incomplete => (
          'Not yet',
          'A few required details are still missing — keep chatting.',
          Icons.info_outline,
        ),
      // A 409 means "already published" OR "not ready yet" — the wire does not
      // distinguish them, so this copy must not claim either.
      PublishOutcome.conflict => (
          'Not posted',
          'This chat is either already posted, or the draft is not ready yet.',
          Icons.info_outline,
        ),
      PublishOutcome.failed => (
          'Not now',
          'Could not post right now. Please try again.',
          Icons.info_outline,
        ),
      PublishOutcome.none => ('', '', Icons.info_outline),
    };
    if (title.isEmpty) return;
    showBbToast(context, title: title, message: message, icon: icon);
    if (state.publishOutcome == PublishOutcome.success) {
      widget.onPublished?.call();
      widget.onBack();
    }
  }

  @override
  Widget build(BuildContext context) {
    return MultiBlocListener(
      listeners: <BlocListener<JobPostingChatBloc, JobPostingChatState>>[
        BlocListener<JobPostingChatBloc, JobPostingChatState>(
          listenWhen: (JobPostingChatState p, JobPostingChatState c) =>
              c.messages.length > p.messages.length,
          listener: (_, __) => _animateToBottom(),
        ),
        BlocListener<JobPostingChatBloc, JobPostingChatState>(
          listenWhen: (JobPostingChatState p, JobPostingChatState c) =>
              c.publishOutcome != p.publishOutcome &&
              c.publishOutcome != PublishOutcome.none,
          listener: _onPublishOutcome,
        ),
        // The draft panel opens ITSELF the first time the engine says it is
        // ready, so a payer who never taps "View draft" still sees exactly what
        // is about to be created before anything is created.
        BlocListener<JobPostingChatBloc, JobPostingChatState>(
          listenWhen: (JobPostingChatState p, JobPostingChatState c) =>
              c.draftReady && !p.draftReady,
          listener: (_, __) {
            if (_autoOpenedDraft) return;
            setState(() {
              _autoOpenedDraft = true;
              _draftOpen = true;
            });
          },
        ),
      ],
      child: BlocBuilder<JobPostingChatBloc, JobPostingChatState>(
        builder: (BuildContext context, JobPostingChatState state) {
          return Column(
            children: <Widget>[
              _header(state),
              if (state.sessionFailed) _sessionBanner(),
              Expanded(
                child: state.initializing
                    ? const Center(child: CircularProgressIndicator())
                    : ListView(
                        controller: _scroll,
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.s4,
                          vertical: AppSpacing.s2,
                        ),
                        children: <Widget>[
                          for (int i = 0; i < state.messages.length; i++)
                            _bubble(state.messages[i], i),
                          if (_draftOpen) ...<Widget>[
                            const SizedBox(height: AppSpacing.s3),
                            DraftPreview(
                              draft: state.draft,
                              ready: state.draftReady,
                              publishing: state.publishing,
                              onPublish: _publish,
                            ),
                          ],
                        ],
                      ),
              ),
              if (state.sending)
                _typingIndicator()
              else if (state.followups.isNotEmpty)
                _followups(state.followups),
              if (state.lastReplyBlocked)
                _notice(
                  icon: Icons.error_outline,
                  color: AppColors.dangerPress,
                  text: kJobChatBlockedNotice,
                ),
              _inputBar(),
              const SizedBox(height: AppSpacing.s2),
            ],
          );
        },
      ),
    );
  }

  Widget _bubble(ChatMessage m, int i) {
    final bool failed = m.status == ChatSendStatus.failed;
    return BbChatBubble(
      text: m.text,
      fromPayer: m.fromPayer,
      failed: failed,
      onRetry: failed ? () => _retry(i) : null,
    );
  }

  Widget _header(JobPostingChatState state) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          BbIconButton(
            icon: Icons.arrow_back,
            semanticLabel: 'Back',
            onPressed: widget.onBack,
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Text(
              kJobChatTitle,
              style: AppTypography.display(
                size: AppTypography.sizeLg,
                weight: FontWeight.w800,
              ),
            ),
          ),
          // The draft is reviewable at ANY time, not only once the engine is
          // done — a payer must never have to guess what has been captured.
          TextButton(
            onPressed: () => setState(() => _draftOpen = !_draftOpen),
            child: Text(
              _draftOpen ? 'Hide draft' : 'View draft',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                weight: FontWeight.w700,
                color: AppColors.textBrand,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sessionBanner() {
    return Container(
      width: double.infinity,
      color: AppColors.dangerTint,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s3,
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.cloud_off, size: 18, color: AppColors.dangerPress),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              kJobChatSessionFailedLabel,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.dangerPress,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// A thin one-line notice above the composer. Additive — never replaces a
  /// bubble, and reads as calm context rather than an error screen.
  Widget _notice({
    required IconData icon,
    required Color color,
    required String text,
  }) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s1,
      ),
      child: Row(
        children: <Widget>[
          Icon(icon, size: 16, color: color),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              text,
              style: AppTypography.body(size: AppTypography.sizeSm, color: color),
            ),
          ),
        ],
      ),
    );
  }

  /// Deliberately STATIC (a dots glyph, not a spinner): an indefinite animation
  /// never lets `pumpAndSettle` settle, and the value here is the honest "still
  /// working" cue, not motion.
  Widget _typingIndicator() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.more_horiz, size: 20, color: AppColors.brand),
          const SizedBox(width: AppSpacing.s2),
          Flexible(
            child: Text(
              kJobChatTypingLabel,
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

  Widget _followups(List<String> followups) {
    return Container(
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s4,
        AppSpacing.s1,
        AppSpacing.s4,
        AppSpacing.s2,
      ),
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

  Widget _inputBar() {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s4,
        vertical: AppSpacing.s1,
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
              style: AppTypography.body(size: AppTypography.sizeSm),
              decoration: const InputDecoration(
                hintText: 'Type your answer…',
                isDense: true,
                contentPadding: EdgeInsets.symmetric(
                  horizontal: AppSpacing.s3,
                  vertical: AppSpacing.s2,
                ),
              ),
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
                child: Icon(
                  Icons.send_rounded,
                  color: AppColors.textOnBrand,
                  size: 22,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
