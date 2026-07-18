import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:share_plus/share_plus.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pdf_downloader.dart';
import '../../../core/util/transient_retry.dart';
import '../../../core/util/resume_file_name.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';
import 'cubit/resume_cubit.dart';
import 'resume_photo_header.dart';

class ResumePreviewScreen extends StatelessWidget {
  const ResumePreviewScreen({super.key, this.initialResume});

  /// The resume text generated upstream by the Building screen. When present it
  /// is shown directly (no re-generation); when null the screen generates.
  final String? initialResume;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ResumeCubit>(
      create: (_) {
        final ResumeCubit cubit = locator<ResumeCubit>();
        if (initialResume != null) {
          cubit.showGenerated(initialResume!);
        } else {
          cubit.generate();
        }
        return cubit;
      },
      child: const _ResumeView(),
    );
  }
}

class _ResumeView extends StatefulWidget {
  const _ResumeView();

  @override
  State<_ResumeView> createState() => _ResumeViewState();
}

class _ResumeViewState extends State<_ResumeView> {
  /// Bumped every time the worker returns from the edit screen, and used as the
  /// [ResumePhotoHeader]'s key so a NEW State is built and the photo re-fetched.
  ///
  /// The header loads only in initState, so without this a photo the worker just
  /// added/removed never appeared on return — the preview kept showing the photo
  /// state from when the screen first mounted. Keyed rather than lifting the
  /// photo into ResumeCubit: the header is deliberately self-contained and
  /// fail-silent (the photo is garnish; it must never cost the worker their
  /// resume text), and a key keeps that property.
  int _photoNonce = 0;

  /// Returning from the editor: the photo may have changed either way, so always
  /// refetch it. Regenerate ONLY on a real name change — the name is baked in at
  /// generation time, and an unconditional regenerate would spend one of the
  /// worker's 5 daily generates and bin the rendered PDF.
  void _onEditReturned(bool nameChanged) {
    if (!mounted) return;
    setState(() => _photoNonce++);
    if (nameChanged) {
      context.read<ResumeCubit>().generate(force: true);
    }
  }

  /// The Resume tab came back into view. Refetch the resume text AND the photo
  /// strip. The photo can be changed from the PROFILE tab (ADR-0032 B1-B3 — one
  /// photo flow, reachable from Profile too), so on returning here we must
  /// re-fetch it; without bumping [_photoNonce] the header — which loads only in
  /// initState — kept showing mount-time state until the worker opened and
  /// backed out of the editor. Bumping the nonce rebuilds a fresh header that
  /// re-fetches. refresh() (not generate) for the text, for the reason below.
  void _onTabFocused() {
    if (!mounted) return;
    setState(() => _photoNonce++);
    context.read<ResumeCubit>().refresh();
  }

  @override
  Widget build(BuildContext context) {
    // The IndexedStack keeps this branch mounted, so create: runs only on the
    // first visit — refetch when the tab comes back into view (T4).
    //
    // refresh(), never generate(force: true): a forced generate on every tab
    // switch would overwrite the resume row server-side, reset the PDF to
    // 'pending' and re-enqueue the render — binning the worker's rendered PDF
    // and burning their 5/day generate cap just for looking at the tab.
    return TabFocusRefetch(
      tabFocus: locator<TabFocus>(),
      index: TabIndex.resume,
      onFocused: _onTabFocused,
      child: BlocBuilder<ResumeCubit, ResumeState>(
        builder: (BuildContext context, ResumeState state) {
          return BbScaffold(
            appBar: const BbAppBar(title: 'Your resume'),
            body: switch (state.status) {
              ResumeStatus.loading =>
                const Center(child: CircularProgressIndicator()),
              ResumeStatus.noProfile => _buildNoProfile(context),
              ResumeStatus.failed => _buildFailed(context),
              ResumeStatus.ready => _buildResume(context, state.resumeText),
            },
          );
        },
      ),
    );
  }

  Widget _buildResume(BuildContext context, String resumeText) {
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s6),
      children: <Widget>[
        Card(
          // A clearer lift than the default card so the resume stands out on the
          // paper background.
          elevation: 6,
          shadowColor: AppColors.ink900.withValues(alpha: 0.18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // ADR-0032: the worker's OWN photo — rendered ONLY when the
              // "Photo dikhayein" pref is on AND a photo exists (the toggle
              // finally gates something). Self-contained + fail-silent: works
              // on both entry paths (generate + Building handoff) and never
              // fabricates a placeholder into the resume itself.
              // Keyed on the edit-return nonce so a photo the worker just
              // added/removed is re-fetched instead of showing mount-time state.
              ResumePhotoHeader(key: ValueKey<int>(_photoNonce)),
              Padding(
                padding: const EdgeInsets.all(AppSpacing.s4),
                child: Text(
                  resumeText,
                  style: AppTypography.body(size: AppTypography.sizeMd),
                ),
              ),
              const Divider(height: 1, color: AppColors.divider),
              // In-card actions: download the PDF (GET /resume/:id/download —
              // real, worker-authed), SHARE that PDF to WhatsApp (#336 — the
              // parity item that was never built), + the safe-field edit
              // entry-point.
              Padding(
                padding: const EdgeInsets.all(AppSpacing.s4),
                child: Column(
                  children: <Widget>[
                    const _DownloadResumeButton(),
                    const SizedBox(height: AppSpacing.s2),
                    const ResumeShareButton(),
                    const SizedBox(height: AppSpacing.s2),
                    _EditResumeButton(onReturned: _onEditReturned),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// Worker has no profile yet — nothing to build a resume from. Guide them to
  /// finish profiling rather than showing a network error.
  Widget _buildNoProfile(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(Icons.badge_outlined,
                size: 48, color: AppColors.textMuted),
            const SizedBox(height: AppSpacing.s4),
            Text('Abhi resume nahi ban sakta.',
                textAlign: TextAlign.center,
                style: AppTypography.display(size: AppTypography.sizeMd)),
            const SizedBox(height: AppSpacing.s2),
            Text(
                'Pehle apna profile poora karein — fir resume apne aap ban jayega.',
                textAlign: TextAlign.center,
                style: AppTypography.body(color: AppColors.textSecondary)),
            const SizedBox(height: AppSpacing.s6),
            BbButton(
              label: 'Profile poora karein',
              iconLeft: Icons.arrow_forward_rounded,
              onPressed: () => context.go(Routes.consent),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildFailed(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Icon(Icons.cloud_off_rounded,
              size: 48, color: AppColors.textMuted),
          const SizedBox(height: AppSpacing.s4),
          Text('Resume abhi ban nahi paya.',
              textAlign: TextAlign.center,
              style: AppTypography.display(size: AppTypography.sizeMd)),
          const SizedBox(height: AppSpacing.s2),
          Text('Thodi der baad dobara try karein.',
              textAlign: TextAlign.center,
              style: AppTypography.body(color: AppColors.textSecondary)),
          const SizedBox(height: AppSpacing.s6),
          BbButton(
            label: 'Try again',
            iconLeft: Icons.refresh_rounded,
            onPressed: context.read<ResumeCubit>().generate,
          ),
        ],
      ),
    );
  }
}

/// "Download PDF" CTA. Resolves a short-lived signed url via the cubit and
/// downloads the PDF IN-APP into the device's Downloads — the worker stays on
/// this screen (started/complete SnackBars, "Kholein" opens the saved file).
/// The button stays busy (disabled) for the WHOLE download so a double-tap
/// can't produce double files. The url is fetched in memory, never logged.
/// "Edit resume" — opens the safe-field editor and, when the worker actually
/// CHANGED THEIR NAME, regenerates the resume on return.
///
/// The name is baked into the resume at generation time, so a PATCHed name was
/// invisible here: the editor popped a bare `null` and the preview kept showing
/// the old text (and downloaded a PDF titled with the old name, #398).
/// Regenerating rebuilds the text AND — because a generate resets the row to
/// render_status 'pending' server-side — re-enqueues the PDF render.
///
/// Gated on `changed == true` deliberately: an unconditional regenerate would
/// spend one of the worker's 5 daily generates and bin the rendered PDF on every
/// prefs-only save.
class _EditResumeButton extends StatelessWidget {
  const _EditResumeButton({required this.onReturned});

  /// Called when the editor pops, with TRUE when the worker's NAME changed.
  final ValueChanged<bool> onReturned;

  @override
  Widget build(BuildContext context) {
    return BbButton(
      label: 'Edit resume',
      block: true,
      variant: BbButtonVariant.ghost,
      iconLeft: Icons.edit_outlined,
      onPressed: () async {
        // The editor pops `true` only when the name actually changed; a
        // dismissed screen pops null.
        final bool? changed = await context.push<bool>(Routes.resumeEdit);
        onReturned(changed == true);
      },
    );
  }
}

/// How many times the download resolver re-checks a "still rendering" 409, and
/// how long it waits between checks.
///
/// 20 x 1500ms = 30s of waiting. The budget MUST outlast the server's own render
/// timeout — PdfRenderer.RENDER_TIMEOUT_MS is 20s — plus the Storage upload that
/// follows it. The previous ~6s budget was the first-tap download failure: a
/// cold WeasyPrint start (with a photo to fetch and embed) routinely runs past
/// 6s, so the poll gave up and told the worker it had failed while the render
/// was still perfectly healthy. They tapped again, and the second tap often
/// worked purely because the render had finished in the meantime.
///
/// Still BOUNDED, because it must be: when rendering is disabled server-side the
/// row stays 'pending' forever, and the worker has to get the honest "taiyaar ho
/// rahi hai" rather than an endless spinner.
const int _kReadyMaxAttempts = 20;
const Duration _kReadyPollInterval = Duration(milliseconds: 1500);

/// Button label while the PDF is still rendering — honest progress, not an
/// error. The worker is not waiting on their phone; they are waiting on a render.
const String kResumePreparingLabel = 'PDF taiyaar ho rahi hai…';

/// The saved/shared file name derived from the worker's OWN name (§2 self-read,
/// no LLM — see [resumeDownloadFileName]), or [kFallbackResumeFileName] when the
/// name cannot be read.
///
/// NEVER throws: a name-fetch failure (offline / session gone / unset name) must
/// not cost the worker their PDF — the name on the file is a nicety, not a
/// precondition. Shared by the download and share buttons so the document a
/// factory owner receives on WhatsApp carries the same NAME_..._RESUME.pdf the
/// Downloads folder does.
Future<String> _loadResumeFileName() async {
  try {
    final ResumeSafeFields fields = await locator<ResumeEditRepository>().load();
    return resumeDownloadFileName(fields.displayName);
  } catch (_) {
    return kFallbackResumeFileName;
  }
}

/// Resolves the signed url, tolerating the SHORT "still rendering" window.
///
/// A generate resets the row to render_status 'pending' and re-enqueues the
/// render, so right after an edit-driven regenerate the first download
/// legitimately 409s (→ [ResumeNotReadyFailure]). One-shotting that told the
/// worker their download failed when it was simply seconds early. Poll briefly
/// instead — the caller's button stays in its loading state, so this reads as
/// "checking…" rather than a stall. [onPreparing] fires the first time a 409 is
/// seen so the button can say WHY it is waiting.
///
/// Deliberately BOUNDED and short: when rendering is disabled server-side the
/// PDF never arrives, and the worker must get the honest "taiyaar ho rahi hai"
/// rather than an indefinite spinner. Only the not-ready case retries — every
/// other failure surfaces immediately. The url handling itself is untouched
/// (in-app fetch; no url_launcher).
///
/// Top-level rather than a method on the download button because the SHARE
/// button (#336) mints the same url and must tolerate the same render window —
/// a worker who just regenerated and tapped "WhatsApp par bhejein" would
/// otherwise be told their resume failed while it was still rendering fine.
Future<String?> resolveSignedResumeUrl(
  ResumeCubit cubit, {
  required VoidCallback onPreparing,
}) async {
  for (int attempt = 0; attempt < _kReadyMaxAttempts; attempt++) {
    final bool lastAttempt = attempt == _kReadyMaxAttempts - 1;
    try {
      return await cubit.resolveDownloadUrl();
    } on ResumeNotReadyFailure {
      if (lastAttempt) rethrow;
      // Say WHY the wait is happening — the PDF is rendering, nothing is wrong.
      onPreparing();
      await Future<void>.delayed(_kReadyPollInterval);
    } catch (error) {
      // A transient 5xx / transport blip on the mint is the OTHER reason a
      // first tap failed and a second worked: only the 409 was retried, so a
      // 500 fell straight through to "Server error (500)". Ride it out on the
      // SAME bounded budget rather than nesting a second retry loop inside
      // this one (which would multiply 20 attempts into 60 requests).
      //
      // Deliberately does NOT call onPreparing: the PDF is not rendering, the
      // server hiccuped, and claiming otherwise would be a lie.
      if (lastAttempt || !isTransientFailure(error)) rethrow;
      await Future<void>.delayed(_kReadyPollInterval);
    }
  }
  return null; // unreachable: the last attempt either returns or rethrows.
}

class _DownloadResumeButton extends StatefulWidget {
  const _DownloadResumeButton();

  @override
  State<_DownloadResumeButton> createState() => _DownloadResumeButtonState();
}

class _DownloadResumeButtonState extends State<_DownloadResumeButton> {
  bool _loading = false;

  /// True once the ready-poll has seen at least one "still rendering" 409 — the
  /// button then says so instead of looking like a dead spinner.
  bool _preparing = false;

  /// The in-flight name prefetch. AWAITED at tap time (not just fired on mount):
  /// _fileName is read when the file is saved, so a worker who tapped Download
  /// before the prefetch resolved silently got the generic
  /// BadaBhai_Resume.pdf instead of NAME_..._RESUME.pdf — the #398 naming
  /// vanishing exactly for the fastest taps.
  Future<void>? _namePrefetch;

  /// The saved-file name, derived from the worker's OWN name (§2 self-read, no
  /// LLM — see [resumeDownloadFileName]). PREFETCHED on mount so the tap adds no
  /// latency; it stays the generic [kFallbackResumeFileName] until (and unless)
  /// the name resolves. A name-fetch failure NEVER blocks the download — the
  /// worker's name on the file is a nicety, not a precondition.
  String _fileName = kFallbackResumeFileName;

  @override
  void initState() {
    super.initState();
    // Started on mount so the tap usually adds no latency; the tap awaits it.
    _namePrefetch = _prefetchFileName();
  }

  Future<void> _prefetchFileName() async {
    final String name = await _loadResumeFileName();
    if (!mounted) return;
    setState(() => _fileName = name);
  }

  /// Marks the button "PDF taiyaar ho rahi hai…" the first time the ready-poll
  /// sees a 409. Passed to [resolveSignedResumeUrl] as its `onPreparing` hook.
  void _markPreparing() {
    if (mounted && !_preparing) setState(() => _preparing = true);
  }

  Future<void> _download() async {
    final ResumeCubit cubit = context.read<ResumeCubit>();
    setState(() => _loading = true);
    // Let the name land before the file is saved (#398). It was fire-and-forget,
    // so a fast tap raced it and saved the generic name. Never blocking: the
    // prefetch swallows its own failures and simply leaves the fallback, so a
    // worker with no name on file still gets their PDF.
    await _namePrefetch;
    if (!mounted) return;
    await downloadSignedPdf(
      context,
      resolve: () =>
          resolveSignedResumeUrl(cubit, onPreparing: _markPreparing),
      fileName: _fileName,
    );
    if (mounted) {
      setState(() {
        _loading = false;
        _preparing = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return BbButton(
      // Honest progress while the server renders — not an error, and not a
      // silent spinner.
      label: _preparing ? kResumePreparingLabel : 'Download Resume',
      block: true,
      iconLeft: Icons.download_rounded,
      loading: _loading,
      onPressed: _loading ? null : _download,
    );
  }
}

// Worker-facing share copy, exported so tests assert the exact honest lines.
const String kResumeShareLabel = 'WhatsApp par bhejein';
const String kResumeSharePreparingNotice = 'Resume taiyaar kar rahe hain…';
const String kResumeShareGenericFailureNotice =
    'Resume bhej nahi paye. Dobara koshish karein.';
const String kResumeShareNoLinkNotice =
    'PDF link abhi nahi mil paya. Dobara koshish karein.';
const String kResumeShareMockNotice =
    'Demo resume bheja nahi ja sakta. Asli resume ban jaane par bhejein.';

/// The message that travels ALONGSIDE the attached PDF.
///
/// Deliberately carries no name, no phone number and no link: the worker's
/// details are already inside the document they chose to send, and anything
/// extra here would be PII we put into a chat thread on their behalf. Written
/// gender-neutrally — every worker sends the same line.
const String kResumeShareText =
    'Mera resume — BadaBhai app se banaya hai. Kaam ke liye baat karte hain.';

/// Hands the resume PDF to the platform share sheet.
///
/// Takes BYTES and a file name — never a url — so the signed credential is
/// structurally incapable of reaching a chat thread through this seam (see the
/// #354 note on [ResumeShareButton]). Injected so tests never touch the native
/// share plugin.
typedef ResumeShareFn = Future<void> Function({
  required Uint8List bytes,
  required String fileName,
  required String text,
});

/// Production [ResumeShareFn] — the system share sheet with the PDF attached.
Future<void> _shareResumeFile({
  required Uint8List bytes,
  required String fileName,
  required String text,
}) async {
  // fileNameOverrides is not optional here: cross_file drops XFile.name on every
  // platform except web, and without the override share_plus stages the
  // attachment under an invented uuid — the factory owner would receive
  // "a1b2c3d4.pdf" instead of RAMESH_KUMAR_RESUME.pdf and have no idea whose
  // resume they just opened.
  await Share.shareXFiles(
    <XFile>[XFile.fromData(bytes, mimeType: 'application/pdf', name: fileName)],
    fileNameOverrides: <String>[fileName],
    text: text,
  );
}

/// Pulls the resume PDF's BYTES from the signed [uri] into memory.
///
/// In-app, exactly like the download path: the url is a single-use credential
/// and must never be handed to another app or process. Non-200 → typed
/// [ServerFailure] so the honest status reaches the worker; a 5xx blip is ridden
/// out (a GET is idempotent, so the retry is free), and [kPdfDownloadTimeout]
/// bounds EACH attempt so a dead-but-open socket cannot spin the button forever.
///
/// Held in memory rather than staged through a temp file the way the download
/// does: a resume PDF is a few hundred KB, and this way the app keeps no copy of
/// its own to clean up (share_plus stages the attachment in the OS temp dir it
/// manages, and the OS reclaims that).
Future<Uint8List> _fetchResumePdfBytes(http.Client client, Uri uri) {
  return retryTransient(() async {
    final http.Response res =
        await client.get(uri).timeout(kPdfDownloadTimeout);
    if (res.statusCode != 200) throw ServerFailure(res.statusCode);
    return res.bodyBytes;
  });
}

/// "WhatsApp par bhejein" — shares the resume as an attached PDF (#336).
///
/// The build-kit parity item that was never built: the worker could save their
/// PDF to Downloads but had no way to actually SEND it to the factory owner who
/// asked for it, which is the entire point of having a resume. The system sheet
/// is used rather than a `wa.me` deep link — a deep link can only carry text (so
/// it could only carry the url, see below), and the sheet puts WhatsApp first on
/// virtually every worker's phone while still working when it is not installed.
///
/// SECURITY — SHARE THE FILE, NEVER THE URL (#354). DO NOT "SIMPLIFY" THIS.
/// The url minted by GET /resume/:id/download is a SIGNED, time-limited
/// credential: anyone holding it can pull the worker's resume until it expires.
/// Pasting it into a chat would hand that credential to WhatsApp, to everyone in
/// the group, and to every forward after that — permanently out of our control,
/// and pointing at a document full of the worker's PII. #354 was exactly this
/// bug in the payer app (a signed url reaching the system clipboard). So: the
/// url is fetched IN-APP, held in memory only, never logged or displayed, and
/// only the resulting BYTES cross the share boundary. [ResumeShareFn] takes
/// bytes precisely so a later edit cannot casually pass a url through it.
///
/// DOWNLOAD-THEN-SHARE, always — there is no "download it first" precondition
/// and no disabled state. Tapping mints a fresh url, pulls the bytes and hands
/// the file to the sheet. Sharing whatever the Download button happened to leave
/// behind was the alternative and it is worse on every count: the saved file is
/// an opaque `content://` MediaStore handle on API 29+ (not readable as a path),
/// it goes stale the moment an edit-driven regenerate re-renders the PDF, and a
/// worker who never tapped Download would face a dead button with nothing
/// explaining why. A failure here NEVER falls back to sharing the url — it says
/// the real reason and shares nothing.
class ResumeShareButton extends StatefulWidget {
  const ResumeShareButton({super.key, this.share, this.httpClient});

  /// Injectable ONLY as test seams; production passes neither (same convention
  /// as [downloadSignedPdf]).
  final ResumeShareFn? share;
  final http.Client? httpClient;

  @override
  State<ResumeShareButton> createState() => _ResumeShareButtonState();
}

class _ResumeShareButtonState extends State<ResumeShareButton> {
  bool _loading = false;

  /// True once the ready-poll has seen at least one "still rendering" 409 — the
  /// button then says so instead of looking like a dead spinner.
  bool _preparing = false;

  void _markPreparing() {
    if (mounted && !_preparing) setState(() => _preparing = true);
  }

  Future<void> _share() async {
    final ResumeCubit cubit = context.read<ResumeCubit>();
    // Captured before the async gaps so we never touch `context` after an await
    // (use_build_context_synchronously).
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    setState(() => _loading = true);
    messenger
      ..clearSnackBars()
      ..showSnackBar(
          const SnackBar(content: Text(kResumeSharePreparingNotice)));

    // Resolved at tap time rather than prefetched on mount the way the download
    // button does it: a second load() per mount would double this screen's
    // network work to save a few hundred ms the worker cannot notice behind the
    // "taiyaar kar rahe hain" notice. Never throws — worst case the document is
    // named BadaBhai_Resume.pdf, which is not worth failing a share over.
    final String fileName = await _loadResumeFileName();

    String? reason; // the actual failure to surface, or null on success
    try {
      final String? url =
          await resolveSignedResumeUrl(cubit, onPreparing: _markPreparing);
      final Uri? uri = (url == null || url.isEmpty) ? null : Uri.tryParse(url);
      if (uri == null) {
        // Minted, but no usable url came back.
        reason = kResumeShareNoLinkNotice;
      } else if (uri.scheme == 'mock') {
        // MOCK MODE: MockApiClient's `mock://` sentinel points nowhere. The
        // download path writes a placeholder PDF instead, but those bytes live
        // behind pdf_downloader's @visibleForTesting buildPlaceholderPdfBytes —
        // off-limits from lib/ — so say so plainly rather than send a corrupt
        // zero-byte "resume" into someone's WhatsApp.
        reason = kResumeShareMockNotice;
      } else {
        final http.Client client = widget.httpClient ?? http.Client();
        try {
          final Uint8List bytes = await _fetchResumePdfBytes(client, uri);
          await (widget.share ?? _shareResumeFile)(
            bytes: bytes,
            fileName: fileName,
            text: kResumeShareText,
          );
        } finally {
          if (widget.httpClient == null) client.close();
        }
      }
    } on Failure catch (f) {
      // The typed cause (network / server 5xx / 401 / PDF-not-rendered / …), so
      // the worker hears the REAL reason — never a generic "check your internet".
      reason = failureReason(f).reason;
    } on TimeoutException {
      reason = failureReason(const NetworkFailure()).reason;
    } on http.ClientException {
      reason = failureReason(const NetworkFailure()).reason;
    } on SocketException {
      reason = failureReason(const NetworkFailure()).reason;
    } catch (_) {
      // Includes a PlatformException from the share sheet itself.
      reason = kResumeShareGenericFailureNotice;
    }

    if (!mounted) return;
    setState(() {
      _loading = false;
      _preparing = false;
    });
    // On success the share sheet IS the confirmation — drop the "taiyaar kar
    // rahe hain" line rather than stacking another notice on top of it.
    messenger.clearSnackBars();
    if (reason != null) {
      messenger.showSnackBar(SnackBar(content: Text(reason)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return BbButton(
      // Same honest progress line the download button shows while the server
      // renders — waiting on a render is not an error.
      label: _preparing ? kResumePreparingLabel : kResumeShareLabel,
      block: true,
      variant: BbButtonVariant.secondary,
      iconLeft: Icons.share_rounded,
      loading: _loading,
      // Busy for the WHOLE share so a double-tap can't open two sheets.
      onPressed: _loading ? null : _share,
    );
  }
}
