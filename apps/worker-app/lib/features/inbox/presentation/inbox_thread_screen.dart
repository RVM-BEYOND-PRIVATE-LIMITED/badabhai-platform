import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../domain/inbox_models.dart';
import 'cubit/inbox_thread_cubit.dart';

/// One relay thread (E0 in-app relay, FE #1628): the payer's messages and the
/// worker's replies, oldest first, with the worker's free-text composer.
///
/// NO PAYER IDENTITY IS SHOWN — the wire carries none, and the E0 decision doc
/// defers "what a payer may be identified as" to its own ruling.
class InboxThreadScreen extends StatelessWidget {
  const InboxThreadScreen({super.key, required this.unlockId});

  final String unlockId;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<InboxThreadCubit>(
      create: (_) => locator<InboxThreadCubit>()..load(unlockId),
      child: _ThreadView(unlockId: unlockId),
    );
  }
}

class _ThreadView extends StatefulWidget {
  const _ThreadView({required this.unlockId});

  final String unlockId;

  @override
  State<_ThreadView> createState() => _ThreadViewState();
}

class _ThreadViewState extends State<_ThreadView> {
  final TextEditingController _reply = TextEditingController();
  final ScrollController _scroll = ScrollController();

  @override
  void dispose() {
    _reply.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final String text = _reply.text.trim();
    if (text.isEmpty) return;
    final bool sent =
        await context.read<InboxThreadCubit>().reply(text);
    if (!mounted) return;
    if (sent) {
      _reply.clear();
      await _scrollToEnd();
    }
  }

  Future<void> _scrollToEnd() async {
    if (!_scroll.hasClients) return;
    await Future<void>.delayed(const Duration(milliseconds: 50));
    if (!mounted || !_scroll.hasClients) return;
    _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  @override
  Widget build(BuildContext context) {
    final bool canPop = Navigator.of(context).canPop();
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: 'Sandesh',
            subtitle: 'Payer se baat',
            onBack: canPop ? () => Navigator.of(context).maybePop() : null,
            maxWidth: OnboardingLayout.maxContentWidth,
          ),
          Expanded(
            child: BlocConsumer<InboxThreadCubit, InboxThreadState>(
              listenWhen: (InboxThreadState p, InboxThreadState c) =>
                  p.messages.length != c.messages.length,
              listener: (BuildContext context, InboxThreadState state) {
                // A new message (a sent reply re-loads the thread) scrolls the
                // composer's content into view.
                _scrollToEnd();
              },
              builder: (BuildContext context, InboxThreadState state) {
                return switch (state.status) {
                  InboxThreadStatus.loading => const BbStatusView.loading(),
                  InboxThreadStatus.failed => BbStatusView(
                    icon: failureReason(state.failure).icon,
                    title: 'Sandesh load nahi hua.',
                    subtitle: failureReason(state.failure).reason,
                    action: FilledButton(
                      onPressed: () => context
                          .read<InboxThreadCubit>()
                          .load(widget.unlockId),
                      child: const Text('Try again'),
                    ),
                  ),
                  InboxThreadStatus.closed => const BbStatusView(
                    icon: Icons.lock_outline_rounded,
                    title: 'Yeh sandesh ab uplabdh nahi hai',
                    subtitle: 'Yeh baat ab khuli nahi hai.',
                  ),
                  InboxThreadStatus.ready => _thread(context, state),
                };
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _thread(BuildContext context, InboxThreadState state) {
    return Column(
      children: <Widget>[
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                maxWidth: OnboardingLayout.maxContentWidth,
              ),
              child: ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.all(16),
                itemCount: state.messages.length,
                itemBuilder: (BuildContext context, int index) =>
                    _bubble(context, state.messages[index]),
              ),
            ),
          ),
        ),
        if (state.sendError != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
            child: Text(
              failureReason(state.sendError).reason,
              style: OnboardingTypography.inter(
                size: 12,
                color: OnboardingColors.errorRed,
              ),
            ),
          ),
        _composer(context, state),
      ],
    );
  }

  Widget _bubble(BuildContext context, InboxMessage message) {
    final bool mine = message.fromWorker;
    final BorderRadius radius = BorderRadius.only(
      topLeft: const Radius.circular(14),
      topRight: const Radius.circular(14),
      bottomLeft: Radius.circular(mine ? 14 : 4),
      bottomRight: Radius.circular(mine ? 4 : 14),
    );
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          return Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            constraints: BoxConstraints(maxWidth: constraints.maxWidth * 0.82),
            decoration: BoxDecoration(
              color: mine
                  ? OnboardingColors.shiftBlue
                  : OnboardingColors.paperWhite,
              borderRadius: radius,
              border: mine
                  ? null
                  : Border.all(color: OnboardingColors.borderDefault),
            ),
            child: Text(
              message.text,
              style: OnboardingTypography.inter(
                size: 14,
                weight: FontWeight.w500,
                height: 1.35,
                color: mine
                    ? OnboardingColors.textOnBlue
                    : OnboardingColors.ink900,
              ),
            ),
          );
        },
      ),
    );
  }

  /// Free-text composer (§B — the worker's reply is the affirmative act that
  /// opens the thread to free text both ways).
  Widget _composer(BuildContext context, InboxThreadState state) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
        decoration: const BoxDecoration(
          color: OnboardingColors.paperWhite,
          border: Border(
            top: BorderSide(color: OnboardingColors.borderDefault),
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: <Widget>[
            Expanded(
              child: TextField(
                controller: _reply,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.newline,
                cursorColor: OnboardingColors.shiftBlue,
                style: OnboardingTypography.inter(size: 14),
                decoration: InputDecoration(
                  hintText: 'Apna jawab likhein',
                  hintStyle: OnboardingTypography.inter(
                    size: 14,
                    color: OnboardingColors.ink500,
                  ),
                  border: InputBorder.none,
                ),
              ),
            ),
            const SizedBox(width: 4),
            Semantics(
              button: true,
              label: 'Bhejein',
              child: IconButton(
                onPressed: state.sending ? null : _send,
                icon: const Icon(Icons.send_rounded),
                color: OnboardingColors.shiftBlue,
                disabledColor: OnboardingColors.disabledText,
                tooltip: 'Bhejein',
              ),
            ),
          ],
        ),
      ),
    );
  }
}
