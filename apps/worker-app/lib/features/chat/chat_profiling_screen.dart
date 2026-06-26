import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config.dart';
import '../../core/state/app_state.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_spacing.dart';
import '../../core/widgets/bb_app_bar.dart';
import '../../core/widgets/bb_button.dart';
import '../../core/widgets/bb_chat_bubble.dart';
import '../../router.dart';

class _Message {
  _Message(this.text, {required this.fromWorker});
  final String text;
  final bool fromWorker;
}

class ChatProfilingScreen extends StatefulWidget {
  const ChatProfilingScreen({super.key});

  @override
  State<ChatProfilingScreen> createState() => _ChatProfilingScreenState();
}

class _ChatProfilingScreenState extends State<ChatProfilingScreen> {
  final ApiClient _api = createApiClient();
  final TextEditingController _controller = TextEditingController();
  final List<_Message> _messages = <_Message>[
    _Message('Bada Bhai here. Which machines do you run?', fromWorker: false),
  ];
  bool _ensuringSession = true;

  @override
  void initState() {
    super.initState();
    _ensureSession();
  }

  Future<void> _ensureSession() async {
    final String? workerId = AppState.instance.workerId;
    final String? token = AppState.instance.sessionToken;
    if (workerId != null &&
        token != null &&
        AppState.instance.sessionId == null) {
      final String sessionId = await _api.startSession(authToken: token);
      AppState.instance.setSession(sessionId);
    }
    if (mounted) setState(() => _ensuringSession = false);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final String text = _controller.text.trim();
    if (text.isEmpty) return;
    final String? sessionId = AppState.instance.sessionId;
    final String? token = AppState.instance.sessionToken;
    if (sessionId == null || token == null) return;

    setState(() {
      _messages.add(_Message(text, fromWorker: true));
      _controller.clear();
    });

    final ChatReply reply = await _api.sendMessage(
      sessionId: sessionId,
      authToken: token,
      text: text,
    );
    if (!mounted) return;
    setState(() => _messages.add(_Message(reply.reply, fromWorker: false)));
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
            onPressed: () => Navigator.pushNamed(context, Routes.voiceNote),
          ),
        ],
      ),
      body: _ensuringSession
          ? const Center(child: CircularProgressIndicator())
          : SafeArea(
              child: Column(
                children: <Widget>[
                  Expanded(
                    child: ListView.builder(
                      padding: const EdgeInsets.all(AppSpacing.s4),
                      itemCount: _messages.length,
                      itemBuilder: (BuildContext context, int i) {
                        final _Message m = _messages[i];
                        return BbChatBubble(
                          text: m.text,
                          fromWorker: m.fromWorker,
                        );
                      },
                    ),
                  ),
                  _inputBar(),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(AppSpacing.s4, 0,
                        AppSpacing.s4, AppSpacing.s4),
                    child: BbButton(
                      label: 'Done — build my profile',
                      block: true,
                      iconLeft: Icons.check_circle_outline,
                      onPressed: () =>
                          Navigator.pushNamed(context, Routes.profilePreview),
                    ),
                  ),
                ],
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
          // Green circular send — the "go" action.
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
