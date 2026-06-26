import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chat_bubble.dart';
import '../../../router.dart';
import '../domain/chat_message.dart';
import 'bloc/chat_bloc.dart';

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

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final String text = _controller.text;
    if (text.trim().isEmpty) return;
    context.read<ChatBloc>().add(ChatMessageSent(text));
    _controller.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: BbAppBar(
        title: 'Profiling',
        actions: <Widget>[
          IconButton(
            tooltip: 'Add voice note',
            icon: const Icon(Icons.mic_none, color: AppColors.brand),
            onPressed: () => context.push(Routes.voiceNote),
          ),
        ],
      ),
      body: BlocBuilder<ChatBloc, ChatState>(
        builder: (BuildContext context, ChatState state) {
          if (state.initializing) {
            return const Center(child: CircularProgressIndicator());
          }
          return SafeArea(
            child: Column(
              children: <Widget>[
                Expanded(
                  child: ListView.builder(
                    padding: const EdgeInsets.all(AppSpacing.s4),
                    itemCount: state.messages.length,
                    itemBuilder: (BuildContext context, int i) {
                      final ChatMessage m = state.messages[i];
                      return BbChatBubble(text: m.text, fromWorker: m.fromWorker);
                    },
                  ),
                ),
                _inputBar(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                      AppSpacing.s4, 0, AppSpacing.s4, AppSpacing.s4),
                  child: BbButton(
                    label: 'Done — build my profile',
                    block: true,
                    iconLeft: Icons.check_circle_outline,
                    onPressed: () => context.push(Routes.profilePreview),
                  ),
                ),
              ],
            ),
          );
        },
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
}
