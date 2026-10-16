import 'package:flutter/material.dart';

import '../../../../core/error/failure.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/pdf_downloader.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../resume/presentation/resume_pdf_download.dart';
import '../../domain/chat_resume_download.dart';

/// The in-app PDF download the tile runs — [downloadSignedPdf]'s signature, so
/// a widget test can stand in for the platform save without a method channel.
typedef ChatResumeDownloadFn =
    Future<void> Function(
      BuildContext context, {
      required Future<String?> Function() resolve,
      required String fileName,
    });

Future<void> _defaultDownload(
  BuildContext context, {
  required Future<String?> Function() resolve,
  required String fileName,
}) => downloadSignedPdf(context, resolve: resolve, fileName: fileName);

/// The Bada Bhai chat's "Resume download" tile (owner ask, 2026-10-14; see
/// `chat_resume_download.dart`).
///
/// One card, one line, one button. Tapping the button saves the worker's résumé
/// PDF into the phone's Downloads through the SAME path the Resume tab's
/// Download button takes ([downloadSignedPdf]): the worker stays on the chat,
/// a SnackBar says it started, and the finished one names where the file went
/// and offers "Kholein".
///
/// The button stays busy for the WHOLE download, so a double tap cannot save two
/// files, and says "PDF taiyaar ho rahi hai…" while the server is still
/// rendering a fresh résumé ([pollSignedResumeUrl] waits that window out).
///
/// It KEEPS ITSELF ALIVE while a download runs: the tile sits in the transcript's
/// lazy list, and scrolling it off screen mid-download would otherwise drop the
/// busy latch and let a second tap start a second file.
class ChatResumeDownloadTile extends StatefulWidget {
  const ChatResumeDownloadTile({
    super.key,
    required this.mintUrl,
    this.renderStatus,
    this.onTapped,
    this.onPdfUnavailable,
    this.loadFileName = loadResumeDownloadFileName,
    this.download = _defaultDownload,
  });

  /// Mints ONE signed url for the résumé this tile offers. Lets a typed
  /// [Failure] propagate (a 409 still-rendering included) — the poll and the
  /// download's SnackBar both read it.
  final Future<String> Function() mintUrl;

  /// Reads this résumé's render state for the wait after a "still rendering"
  /// 409, so the wait does not re-mint (see [pollSignedResumeUrl]). Null mints
  /// on every check, as before.
  final Future<String?> Function()? renderStatus;

  /// Told once per tap, before the download starts — the counts-only analytics.
  final VoidCallback? onTapped;

  /// Told when a tap learns the PDF is NOT AVAILABLE (its render failed after
  /// the tile was offered), so the chat can take away a tile that can only
  /// fail. The worker has already been told why, by the download's SnackBar.
  final VoidCallback? onPdfUnavailable;

  /// Test seams. Production passes neither.
  final Future<String> Function() loadFileName;
  final ChatResumeDownloadFn download;

  @override
  State<ChatResumeDownloadTile> createState() => _ChatResumeDownloadTileState();
}

class _ChatResumeDownloadTileState extends State<ChatResumeDownloadTile>
    with AutomaticKeepAliveClientMixin<ChatResumeDownloadTile> {
  bool _busy = false;

  /// True once the poll has seen a "still rendering" 409, so the button says
  /// why it is waiting rather than spinning silently.
  bool _preparing = false;

  /// Started on mount so a tap usually adds no latency; AWAITED at tap time so
  /// the fastest tap still saves NAME_..._RESUME.pdf, never the generic name
  /// (#398). It never throws — a missing name falls back, never blocks.
  late final Future<String> _fileName;

  @override
  void initState() {
    super.initState();
    _fileName = widget.loadFileName();
  }

  @override
  bool get wantKeepAlive => _busy;

  void _markPreparing() {
    if (mounted && !_preparing) setState(() => _preparing = true);
  }

  Future<void> _download() async {
    if (_busy) return;
    setState(() => _busy = true);
    updateKeepAlive();
    widget.onTapped?.call();
    try {
      final String fileName = await _fileName;
      if (!mounted) return;
      await widget.download(
        context,
        resolve: () async {
          try {
            return await pollSignedResumeUrl(
              mint: widget.mintUrl,
              onPreparing: _markPreparing,
              renderStatus: widget.renderStatus,
            );
          } on ResumePdfUnavailableFailure {
            widget.onPdfUnavailable?.call();
            rethrow;
          }
        },
        fileName: fileName,
      );
    } finally {
      // Released however the download ended: a latch left set is a button that
      // never answers a tap again.
      if (mounted) {
        setState(() {
          _busy = false;
          _preparing = false;
        });
        updateKeepAlive();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.s2, bottom: AppSpacing.s2),
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.s3),
        decoration: BoxDecoration(
          color: OnboardingColors.paperWhite,
          borderRadius: BorderRadius.circular(OnboardingRadii.card),
          border: Border.all(color: OnboardingColors.borderDefault),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                // A solid, rounded glyph on the brand's navy disc — the kit's
                // "key icon" treatment (safety yellow on shift blue).
                Container(
                  width: 40,
                  height: 40,
                  decoration: const BoxDecoration(
                    color: OnboardingColors.shiftBlue,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.description_rounded,
                    color: OnboardingColors.safetyYellow,
                    size: 22,
                  ),
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: Text(
                    kChatResumeDownloadTileText,
                    style: OnboardingTypography.inter(
                      size: 14,
                      weight: FontWeight.w600,
                      color: OnboardingColors.shiftBlue,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s3),
            BbButton(
              buttonKey: const ValueKey<String>('chat_resume_download_button'),
              label: _preparing
                  ? kResumePreparingLabel
                  : kChatResumeDownloadButtonLabel,
              block: true,
              allowMultilineLabel: true,
              // Navy, like the Resume tab's own Download: the yellow hero CTA
              // is the chat's, and a screen carries one.
              variant: BbButtonVariant.navy,
              size: BbButtonSize.md,
              iconLeft: Icons.download_rounded,
              loading: _busy,
              onPressed: _busy ? null : _download,
            ),
          ],
        ),
      ),
    );
  }
}
