import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
// The waveform lives under chat/ where it was first built; it is already a
// standalone, reusable leaf (it takes a plain ValueListenable and paints), so it
// is consumed as-is rather than moved.
import '../../../chat/presentation/widgets/voice_wave_visualizer.dart';

/// The LISTENING row: a FULL-WIDTH waveform fills the input slot while the
/// recogniser runs — it just LISTENS (nothing is typed yet) and the bars rise
/// with the voice, tallest in the centre. STOP hides the wave and hands the
/// recognised text back for review; SEND hands it back and sends in one tap.
///
/// Deliberately dumb: it renders [level] and calls back. The dictation itself is
/// [DictationController]'s, and what happens to the recognised text is the host
/// screen's — the composer lands it in its field, another surface may send it.
class DictationBar extends StatelessWidget {
  const DictationBar({
    super.key,
    required this.level,
    required this.onStop,
    required this.onSend,
    this.waveKey,
  });

  /// Normalized 0..1 live mic amplitude — [DictationController.level].
  final ValueListenable<double> level;

  /// Stop listening; the host lands the recognised text for review.
  final VoidCallback onStop;

  /// Stop listening and send the recognised text in one tap.
  final VoidCallback onSend;

  /// Optional key on the waveform slot, so a host's tests can find it.
  final Key? waveKey;

  /// Hinglish name of the stop control — its tooltip AND its accessible name.
  static const String kStopLabel = 'Rokein';

  /// Hinglish name of the send control — its tooltip AND its accessible name.
  static const String kSendLabel = 'Bhejein';

  /// What a screen reader is told about the waveform. Without it the most
  /// important state on the surface — the mic is live — reaches a blind worker
  /// as nothing at all: a [CustomPaint] has no semantics of its own.
  static const String kListeningLabel = 'Sun rahe hain…';

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          // liveRegion: announce the moment the mic goes hot, rather than only
          // if the worker happens to swipe onto this node.
          child: Semantics(
            container: true,
            liveRegion: true,
            label: kListeningLabel,
            child: SizedBox(
              key: waveKey,
              height: AppSpacing.tap,
              child: VoiceWaveVisualizer(level: level),
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.s1),
        // An explicit `label`, not the tooltip alone: a tooltip is published as a
        // semantics TOOLTIP, needs a long-press to be seen, and leaves an
        // icon-only control with no NAME for a worker who cannot read the glyph.
        //
        // `container` + `excludeSemantics` + `onTap` is what actually NAMES the
        // button, and it was measured. A bare `Semantics(label:)` around an
        // [IconButton] does not: the button is its own semantics boundary, so
        // the tree came out as a labelled node with no button flag and no tap
        // action, wrapping a button whose own label was still empty — two focus
        // stops for one control, and the one the worker lands on is the nameless
        // one. This collapses both into a single named, tappable button node.
        _NamedIconButton(
          label: kStopLabel,
          onPressed: onStop,
          icon: const Icon(
            Icons.stop_circle_rounded,
            color: AppColors.textSecondary,
            size: 30,
          ),
        ),
        _NamedIconButton(
          label: kSendLabel,
          onPressed: onSend,
          icon: const Icon(
            Icons.send_rounded,
            color: AppColors.blue,
            size: 24,
          ),
        ),
      ],
    );
  }
}

/// An icon-only [IconButton] that a screen reader can actually NAME: ONE
/// semantics node carrying [label], the button flag and the tap action.
///
/// The naive shape — `Semantics(label: …, child: IconButton(…))` — does not
/// produce that, because [IconButton] introduces its own semantics boundary; the
/// label lands on a separate, non-interactive parent node and the button keeps
/// an empty name. [SemanticsProperties.excludeSemantics] drops the button's own
/// (nameless) node and [SemanticsProperties.onTap] re-publishes the action it
/// carried; the [IconButton] still handles the real pointer tap, because
/// excluding semantics does not touch hit testing.
class _NamedIconButton extends StatelessWidget {
  const _NamedIconButton({
    required this.label,
    required this.onPressed,
    required this.icon,
  });

  /// The Hinglish name — the tooltip AND the accessible name.
  final String label;
  final VoidCallback onPressed;
  final Widget icon;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      button: true,
      label: label,
      excludeSemantics: true,
      onTap: onPressed,
      child: IconButton(
        tooltip: label,
        onPressed: onPressed,
        icon: icon,
      ),
    );
  }
}
