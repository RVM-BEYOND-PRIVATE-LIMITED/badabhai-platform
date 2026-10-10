import 'package:flutter/material.dart';

/// The profile card's two actions — share and download — always side by
/// side (spec §4).
///
/// It owns layout only. The buttons themselves are passed in, so the share
/// button keeps its own #354 bytes-not-url logic and the download button its
/// #398 name prefetch and render poll: this widget cannot change what they do.
///
/// ── ALWAYS HORIZONTAL ───────────────────────────────────────────────────────
///
/// The two labels are the short 'Share' and 'Download', so the pair fits one
/// row on every handset (even 320dp) with room to spare — no stacked layout,
/// no width threshold. At a large system font the labels wrap to two lines
/// (both buttons opt into `allowMultilineLabel`) and the buttons grow
/// taller instead of clipping, so there is still no overflow to guard.
class ResumeActionRow extends StatelessWidget {
  const ResumeActionRow({
    super.key,
    required this.share,
    required this.download,
  });

  /// The green share action (money / WhatsApp tone).
  final Widget share;

  /// The navy download action.
  final Widget download;

  static const double _kGap = 10;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(child: share),
        const SizedBox(width: _kGap),
        Expanded(child: download),
      ],
    );
  }
}
