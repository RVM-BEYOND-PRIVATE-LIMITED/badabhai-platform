import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../router.dart';
import '../theme/app_colors.dart';

/// App-bar action that (re-)opens the Bada Bhai profiling chat — the chat-first
/// "LLM" resume builder.
///
/// Placed on the persistent tab screens (Resume + Profile) so a worker can start
/// a fresh profiling conversation at ANY time, not only during first onboarding —
/// e.g. to rebuild or improve a resume. It pushes [Routes.chatProfiling] onto the
/// root navigator (the same full-screen route the onboarding flow uses), so the
/// chat behaves exactly as it does from anywhere else; the extra entry point is
/// the only new thing.
class BbChatAction extends StatelessWidget {
  const BbChatAction({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Bada Bhai se baat karein',
      icon: const Icon(Icons.forum_outlined, color: AppColors.brand),
      onPressed: () => context.push(Routes.chatProfiling),
    );
  }
}
