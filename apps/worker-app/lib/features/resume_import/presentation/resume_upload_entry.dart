import 'package:flutter/material.dart';

import '../../../core/util/push_once.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../router.dart';
import '../domain/resume_upload_intent.dart';

/// The words for the upload action wherever it is offered outside the chat —
/// door 1 of the upload screen and every entry on a tab — so a worker meets one
/// name for one action wherever they start. (The chat's résumé prompt says the
/// same words through its own byte-shared constant; an entry on a tab has no
/// business depending on the chat for a label.)
const String kResumeUploadEntryLabel = 'Resume upload karein';

/// The second line, where there is room for one (door 1, the Profile tab row):
/// what the worker can bring.
const String kResumeUploadEntryHint = 'PDF, DOCX ya resume ka photo';

/// Opens the upload screen from an explicit "Resume upload karein" entry
/// OUTSIDE the chat — the Résumé tab, "Mere resume", the Profile tab — which
/// is the CEO's "upload at any point".
///
/// A PUSH, not a `go`: the worker came from a tab, and system back must return
/// them to it. `pushOnce`, so a fast double tap cannot stack the screen twice
/// (#1474).
///
/// It carries [ResumeUploadDirectIntent], so the picker opens straight away —
/// the worker already said what they came for. NEVER the chat prompt's
/// [ResumeUploadAutoIntent]: that one also raises `ResumeImportSignal` on
/// completion, and with no prompt standing open behind an entry the signal
/// would sit unconsumed until some LATER prompt, and answer it for the worker.
///
/// After the attempt the screen lands the worker on the Bada Bhai TAB (owner
/// ruling 2026-10-16; see `ResumeUploadScreen._onState`). Asking about the new
/// résumé there — "Kya ye aapka latest resume hai?" — is the server's part: the
/// Bada Bhai chat does not read imports yet, so until it does the tab shows
/// what it always shows.
Future<void> openResumeUploadEntry(BuildContext context) =>
    context.pushOnce<void>(
      Routes.resumeUpload,
      extra: const ResumeUploadDirectIntent(),
    );

/// "Resume upload karein" as a quiet OUTLINE button — the shape the Résumé tab
/// and "Mere resume" both use, so the action looks the same on both.
///
/// Outline, never the yellow primary: a screen carries ONE primary, and the
/// upload is never it — on the ready Résumé tab there is no yellow CTA by
/// design, in its no-résumé states the yellow is that state's own button, and
/// on "Mere resume" it is "+ Banayein". The kit's Anek label, NOT the Inter
/// override the share/download pair was granted — that exception is theirs
/// alone.
class ResumeUploadEntryButton extends StatelessWidget {
  const ResumeUploadEntryButton({
    super.key,
    required this.entryKey,
    this.block = true,
  });

  /// On the tappable button itself, so a test finds the surface it taps.
  final Key entryKey;

  /// Full width in a card stack; intrinsic width under a centred status
  /// view's own button, so the pair reads as one column.
  final bool block;

  @override
  Widget build(BuildContext context) {
    return BbButton(
      buttonKey: entryKey,
      label: kResumeUploadEntryLabel,
      variant: BbButtonVariant.outline,
      size: BbButtonSize.md,
      block: block,
      // Wrap rather than truncate the worker's action at a large system font.
      allowMultilineLabel: true,
      iconLeft: Icons.upload_file_rounded,
      onPressed: () => openResumeUploadEntry(context),
    );
  }
}
