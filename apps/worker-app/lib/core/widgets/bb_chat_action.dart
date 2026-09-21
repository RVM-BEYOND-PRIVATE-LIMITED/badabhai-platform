import 'package:flutter/material.dart';

import '../../core/util/push_once.dart';
import '../../router.dart';
import '../theme/onboarding_theme.dart';

/// App-bar action that (re-)opens the Bada Bhai profiling chat.
///
/// **No longer on the tab headers.** The v3 tab header's yellow chat glyph
/// means FEEDBACK (spec §4), and the Bada Bhai tab is itself the way into the
/// chat — two entry points drawn with the same glyph, meaning different things,
/// is exactly the confusion R2 settled. This stays for any other caller that
/// wants a "start a fresh profiling conversation" action.
class BbChatAction extends StatelessWidget {
  const BbChatAction({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Bada Bhai se baat karein',
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
      ),
      icon: const Icon(
        Icons.forum_outlined,
        size: 20,
        color: OnboardingColors.safetyYellow,
      ),
      onPressed: () => context.pushOnce(Routes.chatProfiling),
    );
  }
}
