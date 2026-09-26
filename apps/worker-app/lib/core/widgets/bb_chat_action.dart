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
/// #1765 — NO CALL SITES, AND KEPT ON PURPOSE.
///
/// It was removed from the Resume and Profile tab headers: the Bada Bhai tab is
/// the way into the chat, and `profile_tab_responsive_test.dart` asserts this
/// widget is absent from that header. It is left in the kit because it is the
/// shipped shape of "go to the chat" and the companion work (ADR-0044) may want
/// exactly that affordance again; deleting and re-deriving it would be the more
/// expensive of the two mistakes. Do not wire it into a tab header without
/// checking that test.
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
