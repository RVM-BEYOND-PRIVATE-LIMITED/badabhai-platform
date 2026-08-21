import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../domain/question_audio_player.dart';
import '../domain/voice_form_models.dart';
import 'profiling_entry.dart';

// Persona-clean copy (scanned by persona_neutrality_test.dart).
const String _kTitle = 'Profile kaise banayein';
const String _kIntro = 'Aap kaise apna profile banana chahte hain.';
const String _kVoiceTitle = 'Sawaal-jawaab';
const String _kVoiceBody = 'Hum sawaal poochhenge, aap bolkar jawaab dijiye.';
const String _kChatTitle = 'Khul kar baat';
const String _kChatBody = 'Aap apne baare mein khud bataiye.';
const String _kSwitchable = 'Baad mein badal sakte hain.';

/// The entry chooser (#638): the worker picks between the two profiling paths,
/// both of which write the SAME profile. Shown ONLY when both paths are
/// available (see [resolveProfilingEntry]) — never as a one-option screen.
///
/// A one-line spoken intro autoplays so a NON-READER can make the choice at all
/// (via the injected [QuestionAudioPlayer]; silent until the TTS corpus lands,
/// #631). Each card carries an honest line about what the path costs the worker.
class VoiceFormEntryChooser extends StatefulWidget {
  const VoiceFormEntryChooser({
    super.key,
    required this.onChoose,
    this.intro,
  });

  final ValueChanged<ProfilingPath> onChoose;

  /// Optional read-aloud for the intro line (autoplayed once).
  final QuestionAudioPlayer? intro;

  @override
  State<VoiceFormEntryChooser> createState() => _VoiceFormEntryChooserState();
}

class _VoiceFormEntryChooserState extends State<VoiceFormEntryChooser> {
  @override
  void initState() {
    super.initState();
    // Autoplay the spoken intro so a non-reader can choose at all. Best-effort:
    // the player degrades to silence, and analytics/UX never block on it.
    widget.intro?.play(const VoiceQuestion(id: 'entry_intro', prompt: _kIntro));
  }

  /// STOP THE INTRO BEFORE ROUTING, not in dispose().
  ///
  /// The routes push, so choosing does not unmount this screen and dispose()
  /// does not run — the intro would keep playing over the destination. For the
  /// voice path that destination is the pre-flight, which spends ~5s measuring
  /// ambient noise: the app's own voice would be measured as the room's, and
  /// can downgrade the worker to the manual-only "kaafi shor hai" tier. It
  /// also breaks the invariant the session cubit is explicit about — PROMPTING
  /// and LISTENING are mutually exclusive. dispose() keeps its stop as the
  /// backstop for a pop.
  void _choose(ProfilingPath path) {
    widget.intro?.stop();
    widget.onChoose(path);
  }

  @override
  void dispose() {
    widget.intro?.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: _kTitle),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s5),
        children: <Widget>[
          Text(_kIntro, style: AppTypography.body(color: AppColors.textSecondary)),
          const SizedBox(height: AppSpacing.s6),
          _card(
            icon: Icons.record_voice_over_outlined,
            title: _kVoiceTitle,
            body: _kVoiceBody,
            onTap: () => _choose(ProfilingPath.voiceForm),
          ),
          const SizedBox(height: AppSpacing.s4),
          _card(
            icon: Icons.chat_bubble_outline,
            title: _kChatTitle,
            body: _kChatBody,
            onTap: () => _choose(ProfilingPath.chat),
          ),
          const SizedBox(height: AppSpacing.s5),
          Text(
            _kSwitchable,
            textAlign: TextAlign.center,
            style: AppTypography.body(
                size: AppTypography.sizeXs, color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }

  Widget _card({
    required IconData icon,
    required String title,
    required String body,
    required VoidCallback onTap,
  }) {
    return Material(
      color: AppColors.surfacePage,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          // Comfortably above the 48px minimum touch target.
          constraints: const BoxConstraints(minHeight: 88),
          padding: const EdgeInsets.all(AppSpacing.s4),
          decoration: BoxDecoration(
            border: Border.all(color: AppColors.ink200),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Row(
            children: <Widget>[
              Icon(icon, size: 28, color: AppColors.blue),
              const SizedBox(width: AppSpacing.s4),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    Text(title, style: AppTypography.display(size: 18)),
                    const SizedBox(height: AppSpacing.s1),
                    Text(body,
                        style: AppTypography.body(
                            size: 14, color: AppColors.textSecondary)),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: AppColors.textMuted),
            ],
          ),
        ),
      ),
    );
  }
}
