import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/state/app_state.dart';
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
  final ApiClient _api = ApiClient();
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
    if (workerId != null && AppState.instance.sessionId == null) {
      final String sessionId = await _api.startSession(workerId);
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
    final String? workerId = AppState.instance.workerId;
    final String? sessionId = AppState.instance.sessionId;
    if (workerId == null || sessionId == null) return;

    setState(() {
      _messages.add(_Message(text, fromWorker: true));
      _controller.clear();
    });

    final String reply = await _api.sendMessage(
      sessionId: sessionId,
      workerId: workerId,
      text: text,
    );
    if (!mounted) return;
    setState(() => _messages.add(_Message(reply, fromWorker: false)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Profiling'),
        actions: <Widget>[
          IconButton(
            tooltip: 'Add voice note',
            icon: const Icon(Icons.mic_none),
            onPressed: () => Navigator.pushNamed(context, Routes.voiceNote),
          ),
        ],
      ),
      body: _ensuringSession
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: <Widget>[
                Expanded(
                  child: ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: _messages.length,
                    itemBuilder: (BuildContext context, int i) {
                      final _Message m = _messages[i];
                      return Align(
                        alignment:
                            m.fromWorker ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: m.fromWorker
                                ? Theme.of(context).colorScheme.primaryContainer
                                : Theme.of(context).colorScheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Text(m.text),
                        ),
                      );
                    },
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: Row(
                    children: <Widget>[
                      Expanded(
                        child: TextField(
                          controller: _controller,
                          decoration: const InputDecoration(
                            border: OutlineInputBorder(),
                            hintText: 'Type your answer…',
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton(onPressed: _send, icon: const Icon(Icons.send)),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: FilledButton(
                    onPressed: () => Navigator.pushNamed(context, Routes.profilePreview),
                    child: const Text('Done — build my profile'),
                  ),
                ),
              ],
            ),
    );
  }
}
