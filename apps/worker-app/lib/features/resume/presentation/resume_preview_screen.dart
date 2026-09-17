import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:share_plus/share_plus.dart';

import '../../../core/api/api_models.dart'
    show ResumeDocument, TradeSheetResumeDocument;
import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/pdf_downloader.dart';
import '../../../core/util/push_once.dart';
import '../../../core/util/taxonomy_labels.dart';
import '../../../core/util/transient_retry.dart';
import '../../../core/util/resume_file_name.dart';
import '../../../core/widgets/bb_alerts_action.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_success_stamp.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_header_actions.dart';
import '../../../core/widgets/kit/kit_status_banner.dart';
import '../../../core/widgets/kit/kit_tab_header.dart';
import '../../../router.dart';
import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';
import 'cubit/resume_cubit.dart';
import 'widgets/resume_action_row.dart';
import 'widgets/resume_card_slots.dart';
import 'widgets/resume_document_view.dart';
import 'widgets/resume_profile_card.dart';
import 'widgets/resume_sections.dart';

/// The Resume tab's navy header (spec §4), shared by ALL FIVE states so the
/// chrome never moves while the resume loads, fails or arrives.
///
/// Bell + Feedback, and nothing else. The chat action that used to sit here
/// opened the onboarding profiling chat, which is not what a yellow chat
/// bubble means in spec §4 — there it means FEEDBACK, and the Bada Bhai tab is
/// where a worker goes to talk to the bot (ruling R2).
class _ResumeTabHeader extends StatelessWidget {
  const _ResumeTabHeader();

  @override
  Widget build(BuildContext context) {
    return const KitTabHeader(
      // KEEP THIS LITERAL: it is the shell landmark the routing and journey
      // tests wait on to know the worker reached the Resume tab.
      title: 'Your resume',
      actions: <Widget>[
        // The relocated Alerts entry point (notifications lost their bottom-nav
        // tab in the kit's 4-tab set), white on the navy band. It carries the
        // reactive unread badge.
        BbAlertsAction(color: OnboardingColors.textOnBlue),
        KitFeedbackAction(),
      ],
    );
  }
}

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
  /// [ResumeProfileCard]'s key so a NEW State is built and the photo + name
  /// re-fetched.
  ///
  /// The card loads only in initState, so without this a photo the worker just
  /// added/removed never appeared on return — the preview kept showing the
  /// state from when the screen first mounted. Keyed rather than lifting the
  /// photo into ResumeCubit: the card is deliberately self-contained and
  /// fail-silent (the photo is garnish; it must never cost the worker their
  /// resume text), and a key keeps that property.
  int _photoNonce = 0;

  /// Returning from the editor: the photo may have changed either way, so always
  /// refetch it. Regenerate ONLY on a real name change — the name is baked in at
  /// generation time, and an unconditional regenerate would spend one of the
  /// worker's 5 daily generates and bin the rendered PDF.
  void _onEditReturned(bool nameChanged) {
    if (!mounted) return;
    // Bump the nonce so the card re-fetches the (possibly new) name + photo from
    // the live resume-fields — the displayed name is NOT baked into the resume text.
    setState(() => _photoNonce++);
    // Reflect a night-shift toggle IMMEDIATELY. Use refreshNightShift(), NOT
    // refresh(): refresh() early-returns while any load is in flight (its `_loading`
    // guard), which was making the toggle appear only after a tab switch.
    // refreshNightShift() is unguarded + lightweight (no resume regenerate), so it
    // always applies. Do NOT generate(force:true) here: that minted a new 'pending'
    // resume version and stalled the next Download ("PDF taiyaar ho rahi"). The
    // name/photo PDF re-render is handled server-side IN PLACE.
    context.read<ResumeCubit>().refreshNightShift();
  }

  /// The Resume tab came back into view. Refetch the resume text AND the photo
  /// strip. The photo can be changed from the PROFILE tab (ADR-0032 B1-B3 — one
  /// photo flow, reachable from Profile too), so on returning here we must
  /// re-fetch it; without bumping [_photoNonce] the card — which loads only in
  /// initState — kept showing mount-time state until the worker opened and
  /// backed out of the editor. Bumping the nonce rebuilds a fresh card that
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
          final bool showBanner =
              state.status == ResumeStatus.ready && !state.awaitingDocument;
          return Scaffold(
            backgroundColor: OnboardingColors.canvasBg,
            body: Column(
              children: <Widget>[
                const _ResumeTabHeader(),
                if (showBanner) _banner(state),
                Expanded(child: _body(context, state)),
              ],
            ),
          );
        },
      ),
    );
  }

  /// The navy status strip under the header (spec §4).
  ///
  /// THE PILL IS THE PDF's REAL STATE, not "there is resume text" (ruling R6).
  /// A worker whose render is still pending now sees the title with NO READY
  /// badge, instead of a green success mark followed by "PDF taiyaar ho rahi
  /// hai…" the moment they tap Download.
  Widget _banner(ResumeState state) {
    return KitStatusBanner(
      title: 'Resume taiyaar',
      pillLabel: state.pdfRendered ? 'READY' : null,
      subline: 'Bilkul free · share-ready',
      // #1058 — the green "stamp" seal lands once, on the transition INTO the
      // ready state (this banner only mounts when the resume is ready). It is
      // keyless so a background refresh/tab-refocus rebuild keeps the same
      // State and never replays the animation.
      trailing: const BbSuccessStamp(size: 32),
    );
  }

  Widget _body(BuildContext context, ResumeState state) {
    return switch (state.status) {
      // Bare centered spinners are banned — use the shared status surface
      // under the same 'Your resume' chrome.
      ResumeStatus.loading => const BbStatusView.loading(),
      ResumeStatus.noProfile => _buildNoProfile(context),
      ResumeStatus.failed => _buildFailed(context),
      // A fresh generate/handoff whose structured document is still being
      // fetched (see ResumeState.awaitingDocument's own doc) — a loader,
      // NEVER the resumeText fallback, so a form-first worker's thin
      // narrative never flashes on screen only to be replaced a moment later
      // by the real trade-sheet content.
      ResumeStatus.ready when state.awaitingDocument =>
        const BbStatusView.loading(caption: 'Resume taiyaar ho raha hai…'),
      ResumeStatus.ready => _resumeList(context, state),
    };
  }

  /// The scrollable card stack (spec §4): the profile card, the trade cards,
  /// then the correction affordance and the control note.
  Widget _resumeList(BuildContext context, ResumeState state) {
    final ResumeDocument? document = state.document;
    final String resumeText = state.resumeText;

    // Presentation-only transform: the resume body is a deterministic
    // `Label: value` template (ADR-0013), so it is re-structured into the
    // design's grouped sections WITHOUT re-fetching or inventing any data — the
    // same real, per-worker text, laid out instead of dumped as one block. Ids
    // are resolved to display names first (defensive; the server already does).
    final ParsedResume parsed = parseResumeText(
      replaceTaxonomyIds(resumeText),
      nightShiftReady: state.nightShiftReady,
    );

    // The profile card's own facts come from whichever shape exists — the
    // trade sheet's server-composed masthead, a generic document's flat
    // fields, or the parsed text. See resolveProfileFacts.
    final ResumeProfileFacts facts = resolveProfileFacts(
      document: document,
      parsed: parsed,
    );

    // #1525 — SWITCH ON THE PROFILE ROAD WHEN THE SERVER KNOWS IT, THEN (only
    // for a form or unknown road) ON FORMAT, NEVER ON `trade`.
    //
    // `source` is the road that produced the profile, not the layout: a
    // chat-road worker whose trade has an authored sheet is still sent
    // `format: "trade_sheet"`, so keying on the format alone would render them
    // as a form-road sheet that they never filled. The chat road gets its own
    // type and NEVER the trade-sheet cards (see [ChatResumeView]).
    //
    // `form` AND null (unknown: old server / pre-migration row) keep EXACTLY
    // today's layout-by-format behaviour, byte for byte (#1525 acceptance):
    // [ResumeDocument.fromJson] already dispatched the wire's `format` string
    // into ONE OF TWO Dart types, so testing the type here is that same switch.
    // Only `trade_sheet` gets the structured card renderer — it is the one
    // layout `resume_text` cannot represent at all (zoned rows, not
    // `Label: value` lines) — while `document == null` (no structured
    // projection yet) and `format: "generic"` both fall through to the SAME
    // text-parsing render, so a non-CNC worker's tab reads as it always did.
    final Widget legacyBody = _legacyResumeBody(
      resumeText,
      parsed,
      state.nightShiftReady,
    );
    final Widget resumeBody = switch (resumeRoadOf(document)) {
      ResumeRoad.chat => ChatResumeView(child: legacyBody),
      ResumeRoad.form || ResumeRoad.unknown =>
        document is TradeSheetResumeDocument
            ? ResumeDocumentView(document: document)
            : legacyBody,
    };

    final double width = MediaQuery.sizeOf(context).width;
    final EdgeInsets side = KitInsets.list(width);

    return ListView(
      // KitInsets keeps the scrollbar at the SCREEN edge while the content
      // column centres and stops at 600 on a tablet (R13).
      padding: EdgeInsets.fromLTRB(side.left, 14, side.right, 28),
      children: <Widget>[
        ResumeProfileCard(
          key: ValueKey<int>(_photoNonce),
          facts: facts,
          profileConfirmed: state.profileConfirmed,
          onEditReturned: _onEditReturned,
          // Download the PDF (GET /resume/:id/download — real, worker-authed)
          // as a deep-blue commitment, and SHARE that PDF in green (#336).
          actions: const ResumeActionRow(
            share: ResumeShareButton(),
            download: _DownloadResumeButton(),
          ),
        ),
        const SizedBox(height: kResumeCardGap),
        resumeBody,
        const SizedBox(height: kResumeCardGap),
        const _ReportCorrectionButton(),
        const SizedBox(height: 16),
        Center(
          child: Text(
            'Naam / photo / phone aap control karte hain',
            textAlign: TextAlign.center,
            style: OnboardingTypography.inter(
              size: 11,
              color: OnboardingColors.ink500,
            ),
          ),
        ),
      ],
    );
  }

  /// The legacy body: sections when the text parses as the deterministic
  /// template, otherwise the raw text so an unexpected shape is shown in full
  /// rather than as a blank card (nothing is lost). Used for `document == null`
  /// AND `format: "generic"` alike (#1343) — see the switch at the
  /// [_resumeList] call site.
  Widget _legacyResumeBody(
    String resumeText,
    ParsedResume parsed,
    bool nightShiftReady,
  ) {
    if (parsed.isEmpty) {
      return KitCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              replaceTaxonomyIds(resumeText),
              style: OnboardingTypography.inter(size: 13, height: 1.45),
            ),
            // Night-shift readiness is a worker PREF carried OUTSIDE the resume
            // text (workers.resumeNightShiftReady), so it must show even when the
            // body falls back to raw prose — never dropped just because the text
            // did not parse into sections. In the template path it lives in the
            // Location section; here it stands on its own so it is NEVER lost.
            const SizedBox(height: 16),
            _nightShiftRow(nightShiftReady),
          ],
        ),
      );
    }
    return ResumeSectionsView(parsed: parsed);
  }

  /// Night-shift readiness rendered as a standalone `Label: Yes/No` line for the
  /// PROSE fallback (a resume body that did not parse into the template sections).
  /// The template path shows the same fact inside the Location section; here it
  /// carries on its own so the worker's answer is NEVER dropped from the tab.
  Widget _nightShiftRow(bool ready) {
    return Text.rich(
      TextSpan(
        children: <InlineSpan>[
          TextSpan(
            text: '$kNightShiftLabel: ',
            style: OnboardingTypography.inter(
              size: 13,
              height: 1.45,
              color: OnboardingColors.ink600,
            ),
          ),
          TextSpan(
            text: ready ? 'Yes' : 'No',
            style: OnboardingTypography.inter(
              size: 13,
              weight: FontWeight.w700,
              height: 1.45,
            ),
          ),
        ],
      ),
    );
  }

  /// Worker has no profile yet — nothing to build a resume from. Guide them to
  /// finish profiling rather than showing a network error.
  Widget _buildNoProfile(BuildContext context) {
    return BbStatusView(
      icon: Icons.badge_outlined,
      title: 'Abhi resume nahi ban sakta.',
      subtitle:
          'Pehle apna profile poora karein — fir resume apne aap ban jayega.',
      action: BbButton(
        label: 'Profile poora karein',
        iconLeft: Icons.arrow_forward_rounded,
        onPressed: () => context.go(Routes.consent),
      ),
    );
  }

  Widget _buildFailed(BuildContext context) {
    return BbStatusView(
      icon: Icons.cloud_off_rounded,
      title: 'Resume abhi ban nahi paya.',
      subtitle: 'Thodi der baad dobara try karein.',
      action: BbButton(
        label: 'Try again',
        iconLeft: Icons.refresh_rounded,
        onPressed: context.read<ResumeCubit>().generate,
      ),
    );
  }
}

/// Spec §4's last row — the worker's way to say a line on their own resume is
/// wrong.
///
/// 'Report correction' only, not the spec's 'Report Correction or Add
/// Certificate': there is no certificate upload anywhere in the app and no
/// endpoint behind one (backend gap B9), so half that button would have been a
/// promise with nothing behind it. It goes to the real feedback screen,
/// carrying the route the worker was on.
class _ReportCorrectionButton extends StatelessWidget {
  const _ReportCorrectionButton();

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      style: OutlinedButton.styleFrom(
        // Spec draws h46; the worker touch floor is 48 and it wins.
        minimumSize: const Size(double.infinity, OnboardingLayout.tapTarget),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(OnboardingRadii.docked),
        ),
        side: const BorderSide(color: OnboardingColors.borderDefault),
        backgroundColor: OnboardingColors.paperWhite,
        foregroundColor: OnboardingColors.ink600,
        textStyle: OnboardingTypography.inter(
          size: 13,
          weight: FontWeight.w600,
        ),
      ),
      onPressed: () => context.pushOnce(Routes.feedback, extra: Routes.resume),
      icon: const Icon(Icons.report_problem_outlined, size: 16),
      // maxLines 2: an `OutlinedButton.icon` label single-line-ellipsises by
      // default, and at a large system font this one did not fit the card
      // width beside its glyph.
      label: const Text(
        'Report correction',
        maxLines: 2,
        textAlign: TextAlign.center,
      ),
    );
  }
}

/// How many times the download resolver re-checks a "still rendering" 409, and
/// how long it waits between checks.
///
/// 50 x 1500ms = 75s of waiting. The budget MUST outlast the server's own render
/// timeout — PdfRenderer.RENDER_TIMEOUT_MS is 20s — PLUS the BullMQ pickup latency,
/// the Storage upload, and (crucially) ONE retry cycle, because the FIRST-EVER
/// render is a COLD WeasyPrint start (Python + fonts load on first spawn) and can
/// legitimately run to ~20s, occasionally timing out once and succeeding on the
/// BullMQ retry (attempts:3, exponential backoff). The old 30s budget barely
/// cleared a single 20s render, so a fresh-registration first download routinely
/// hit "taiyaar ho rahi hai" while the render was still perfectly healthy — the
/// worker just had to tap again once it finished. 75s covers the cold first render
/// end-to-end. Most renders finish in the first ~10s, so the typical wait is short;
/// this only extends the SLOW tail rather than the common case.
///
/// Still BOUNDED, because it must be: when rendering is disabled server-side the
/// row stays 'pending' forever, and the worker has to get the honest "taiyaar ho
/// rahi hai" rather than an endless spinner.
const int _kReadyMaxAttempts = 50;
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
    final ResumeSafeFields fields = await locator<ResumeEditRepository>()
        .load();
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

/// "PDF download karein" — resolves a short-lived signed url via the cubit and
/// downloads the PDF IN-APP into the device's Downloads, so the worker stays on
/// this screen (started/complete SnackBars, "Kholein" opens the saved file).
/// The button stays busy (disabled) for the WHOLE download so a double-tap
/// can't produce double files. The url is fetched in memory, never logged.
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
      resolve: () => resolveSignedResumeUrl(cubit, onPreparing: _markPreparing),
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
      label: _preparing ? kResumePreparingLabel : 'PDF download karein',
      block: true,
      // Same as the share button: wrap rather than truncate the worker's action.
      allowMultilineLabel: true,
      // Spec §4: navy download (deep-blue commitment) + green WhatsApp. There
      // is NO yellow button on this screen by design — yellow lives on the
      // banner headline, not on a CTA here.
      variant: BbButtonVariant.navy,
      size: BbButtonSize.md,
      iconLeft: Icons.download_rounded,
      loading: _loading,
      onPressed: _loading ? null : _download,
    );
  }
}

// Worker-facing share copy, exported so tests assert the exact honest lines.
const String kResumeShareLabel = 'WhatsApp pe bhejein';
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
///
/// Returns the platform [ShareResult] so the caller can report `resume.shared`
/// with the chosen channel ONLY on a real, completed share (#1317) — a
/// dismissed sheet reports nothing.
typedef ResumeShareFn =
    Future<ShareResult> Function({
      required Uint8List bytes,
      required String fileName,
      required String text,
    });

/// Production [ResumeShareFn] — the system share sheet with the PDF attached.
Future<ShareResult> _shareResumeFile({
  required Uint8List bytes,
  required String fileName,
  required String text,
}) {
  // fileNameOverrides is not optional here: cross_file drops XFile.name on every
  // platform except web, and without the override share_plus stages the
  // attachment under an invented uuid — the factory owner would receive
  // "a1b2c3d4.pdf" instead of RAMESH_KUMAR_RESUME.pdf and have no idea whose
  // resume they just opened.
  //
  // The ShareResult is returned (its `status` says whether the worker actually
  // completed the share, its `raw` names the target app) so the caller can emit
  // `resume.shared` on success only.
  return Share.shareXFiles(
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
    final http.Response res = await client
        .get(uri)
        .timeout(kPdfDownloadTimeout);
    if (res.statusCode != 200) throw ServerFailure(res.statusCode);
    return res.bodyBytes;
  });
}

/// "WhatsApp pe bhejein" — shares the resume as an attached PDF (#336).
///
/// The build-kit parity item that was never built: the worker could save their
/// PDF to Downloads but had no way to actually SEND it to the factory owner who
/// asked for it, which is the entire point of having a resume. The system sheet
/// is used rather than a `wa.me` deep link — a deep link can only carry text (so
/// it could only carry the url, see below), and the sheet puts WhatsApp first on
/// virtually every worker's phone while still working when it is not installed.
///
/// The glyph stays [Icons.share_rounded] rather than the spec's chat bubble:
/// this opens the SYSTEM SHEET, not WhatsApp, and in spec §4 the yellow chat
/// bubble in the header already means Feedback — one glyph, one meaning.
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
        const SnackBar(content: Text(kResumeSharePreparingNotice)),
      );

    // Resolved at tap time rather than prefetched on mount the way the download
    // button does it: a second load() per mount would double this screen's
    // network work to save a few hundred ms the worker cannot notice behind the
    // "taiyaar kar rahe hain" notice. Never throws — worst case the document is
    // named BadaBhai_Resume.pdf, which is not worth failing a share over.
    final String fileName = await _loadResumeFileName();

    String? reason; // the actual failure to surface, or null on success
    try {
      final String? url = await resolveSignedResumeUrl(
        cubit,
        onPreparing: _markPreparing,
      );
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
          final ShareResult result = await (widget.share ?? _shareResumeFile)(
            bytes: bytes,
            fileName: fileName,
            text: kResumeShareText,
          );
          // #1317 — report `resume.shared` ONLY on a real, completed share. A
          // dismissed/cancelled sheet (or an unavailable result) posts nothing,
          // so the metric counts shares the worker actually made. Fire-and-forget
          // + best-effort: the share already succeeded, so a failed report must
          // never block or fail it.
          if (result.status == ShareResultStatus.success) {
            _reportShared(cubit, result.raw);
          }
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

  /// Fire-and-forget the `resume.shared` report after a completed share (#1317).
  ///
  /// The channel is derived from the native share's `raw` target — a WhatsApp
  /// share reports "whatsapp", anything else "other". It is a CLOSED
  /// kResumeShareChannels enum token, never the link or any PII (the whole
  /// point of #354 is that the credential never leaves the app — the channel
  /// says which app, not what was sent). Best-effort by construction: the
  /// repository swallows any failure AND the future is caught here, so a lost
  /// report can never fail the share the worker already made.
  void _reportShared(ResumeCubit cubit, String rawTarget) {
    final String channel = rawTarget.toLowerCase().contains('whatsapp')
        ? 'whatsapp'
        : 'other';
    unawaited(cubit.reportShared(channel).catchError((Object _) {}));
  }

  @override
  Widget build(BuildContext context) {
    return BbButton(
      // Same honest progress line the download button shows while the server
      // renders — waiting on a render is not an error.
      label: _preparing ? kResumePreparingLabel : kResumeShareLabel,
      block: true,
      // 'WhatsApp pe bhejein' does not fit one line of a full-width button at a
      // large system font, and it read as 'WhatsApp p…'. The stacked-button row
      // above already gives it the full card width, so the only thing missing
      // was permission to use a second line.
      allowMultilineLabel: true,
      variant: BbButtonVariant.success,
      size: BbButtonSize.md,
      iconLeft: Icons.share_rounded,
      loading: _loading,
      // Busy for the WHOLE share so a double-tap can't open two sheets.
      onPressed: _loading ? null : _share,
    );
  }
}
