import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart' show ResumeHistoryItem;
import '../../../core/di/locator.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../../profile_tab/domain/profile_summary.dart';
import '../../trade_form/domain/trade_form_args.dart' show TierEntry;
import '../../trade_form/presentation/open_trade_form.dart';
import '../../profile_tab/domain/profile_summary_repository.dart';
import 'cubit/resume_cubit.dart';
import 'resume_preview_screen.dart';
import 'widgets/resume_action_row.dart';
import 'widgets/resume_draft_card.dart';
import 'widgets/resume_file_card.dart';
import 'widgets/resume_history_section.dart';

/// The screen's chrome.
const String kResumeHistoryScreenTitle = 'Mere resume';
const String kResumeHistoryScreenSubtitle =
    'Aapke banaye hue saare resume, naye se purane tak.';

/// The list's own micro heading, and the note that says why it is current.
const String kResumeHistoryListLabel = 'Aapke saved resume';
const String kResumeHistorySyncNote = 'Auto-synced';

/// The quick-action banner.
const String kResumeQuickActionLabel = 'Quick action';
const String kResumeQuickActionTitle = 'Naya resume banayein';
const String kResumeQuickActionBody =
    'Doosre trade ya naye tajurbe ke liye Bada Bhai se baat karke naya resume '
    'banayein.';
const String kResumeQuickActionCta = '+ Banayein';

/// The support callout.
const String kResumeHelpTitle = 'Resume me sudhaar chahiye?';
const String kResumeHelpBody =
    'BadaBhai sahayata team se free me resume check karwayein.';

/// What a worker with nothing to list sees. NOT an error — a worker who has
/// made exactly one resume is in a perfectly ordinary state, and so is one on a
/// server built before the history route existed.
const String kResumeHistoryEmptyTitle = 'Abhi koi purana resume nahi.';
const String kResumeHistoryEmptyBody =
    'Jab aap naya resume banayenge, purane yahin dikhte rahenge.';

/// "3 Files" — the count pill beside the title.
String resumeFileCountLabel(int count) =>
    '$count ${count == 1 ? 'File' : 'Files'}';

/// Every résumé this worker has made, on its own screen, reached from the
/// Profile tab (#1687).
///
/// WHY A SEPARATE SCREEN when the Résumé tab already shows the same list: that
/// one is a section UNDER the current résumé — it answers "what else do I
/// have?" while the worker is looking at the live one. This answers "show me
/// everything I have made", which is a Profile-tab question, and it is where a
/// worker goes looking for an older résumé rather than for today's.
class ResumeHistoryScreen extends StatelessWidget {
  const ResumeHistoryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ResumeCubit>(
      // Its OWN cubit, loading only the history: this screen has no business
      // generating or re-reading the résumé itself, and sharing the tab's cubit
      // would make a Profile-tab visit re-run the Résumé tab's whole load.
      create: (_) => locator<ResumeCubit>()..loadHistory(),
      child: const _ResumeHistoryView(),
    );
  }
}

class _ResumeHistoryView extends StatefulWidget {
  const _ResumeHistoryView();

  @override
  State<_ResumeHistoryView> createState() => _ResumeHistoryViewState();
}

class _ResumeHistoryViewState extends State<_ResumeHistoryView> {
  /// The worker's CURRENT profile — where the trade, experience, machines,
  /// city, verification state and the unfinished-profile numbers live. The
  /// history route carries none of them.
  ///
  /// Read FAIL-SILENT: if it does not load, every card simply shows fewer
  /// facts. A résumé list must not be able to fail because a second, optional
  /// read did.
  ProfileSummary? _summary;

  /// Guards [_loadSummary]: tab refocus and the initState read can overlap,
  /// and two concurrent summary reads would settle in either order.
  bool _summaryLoading = false;

  @override
  void initState() {
    super.initState();
    _loadSummary();
  }

  /// Re-reads everything on this screen that another road can change: the
  /// history (a just-built resume lands here) and the summary (a just-
  /// completed form clears `missingFields`, which hides the draft card).
  /// Fail-silent like the initState read — a failed refocus keeps showing
  /// the last good state, never an error.
  void _refetch() {
    if (!mounted) return;
    context.read<ResumeCubit>().loadHistory();
    _loadSummary();
  }

  Future<void> _loadSummary() async {
    if (_summaryLoading) return;
    if (!locator.isRegistered<ProfileSummaryRepository>()) return;
    _summaryLoading = true;
    try {
      // `includeDisplayExtras: true` FOR ATTESTATION (#1782). In lean mode the
      // repository leaves `attested` at `false` without reading it, so the
      // cards' verification note could never be true on this screen — and the
      // code papered over that by falling back to the `verified` LIFECYCLE
      // flag, which is exactly what #1586 forbids. If the note is worth showing
      // at all, the fact behind it has to be fetched.
      final ProfileSummary s = await locator<ProfileSummaryRepository>()
          .summary(includeDisplayExtras: true);
      if (!mounted) return;
      setState(() => _summary = s);
    } catch (_) {
      // Fewer facts on the cards; never an error state on this screen.
    } finally {
      _summaryLoading = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    // The profile branch stays mounted under pushed root routes (the trade
    // form, the tier chooser, building), so `create:`/`initState` run only on
    // the first visit — refetch when the branch comes back into view. Without
    // this the draft card kept showing mount-time `missingFields` after the
    // worker completed "Resume poora karein" and returned. Fires on change
    // only, never on mount, so the first visit still loads exactly once.
    return TabFocusRefetch(
      tabFocus: locator<TabFocus>(),
      index: TabIndex.profile,
      onFocused: _refetch,
      child: Scaffold(
        backgroundColor: OnboardingColors.canvasBg,
        body: BlocBuilder<ResumeCubit, ResumeState>(
          buildWhen: (ResumeState a, ResumeState b) => a.history != b.history,
          builder: (BuildContext context, ResumeState state) {
            final List<ResumeHistoryItem> items = state.history.items
                .take(kResumeHistoryMaxCards)
                .toList(growable: false);
            return Column(
              children: <Widget>[
                ShiftBlueHeader(
                  title: kResumeHistoryScreenTitle,
                  subtitle: kResumeHistoryScreenSubtitle,
                  onBack: () => Navigator.maybePop(context),
                  // The count is REAL — it is the length of what the server sent,
                  // so it cannot claim files the worker does not have. Hidden at
                  // zero rather than shown as "0 Files": a count pill on an empty
                  // list is a placeholder pretending to be data (ruling R8).
                  titleTrailing: items.isEmpty
                      ? null
                      : _CountPill(label: resumeFileCountLabel(items.length)),
                ),
                Expanded(
                  child: SafeArea(top: false, child: _body(context, items)),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _body(BuildContext context, List<ResumeHistoryItem> items) {
    final double width = MediaQuery.sizeOf(context).width;
    final EdgeInsets side = KitInsets.list(width);
    final ProfileSummary? summary = _summary;
    final ProfileSummary? draft =
        summary != null && summary.missingFields.isNotEmpty ? summary : null;
    return ListView(
      padding: EdgeInsets.fromLTRB(side.left, 14, side.right, 28),
      children: <Widget>[
        const _QuickActionBanner(),
        const SizedBox(height: 18),
        if (items.isEmpty)
          // Deliberately the EMPTY view, never an error view: the repository
          // answers `empty` for an older server and for a failed read alike,
          // and neither is something the worker did wrong or can act on.
          const Padding(
            padding: EdgeInsets.only(top: 24),
            child: BbStatusView(
              icon: Icons.description_outlined,
              title: kResumeHistoryEmptyTitle,
              subtitle: kResumeHistoryEmptyBody,
            ),
          )
        else ...<Widget>[
          const _ListHeading(),
          const SizedBox(height: 10),
          for (final ResumeHistoryItem item in items) ...<Widget>[
            ResumeFileCard(
              item: item,
              summary: _summary,
              actions: ResumeActionRow(
                share: ResumeShareButton(resumeId: item.resumeId),
                download: ResumeDownloadButton(resumeId: item.resumeId),
              ),
            ),
            const SizedBox(height: 12),
          ],
        ],
        // The unfinished-profile card. Shown ONLY when the server itself
        // reports missing fields — never as a permanent nag.
        if (draft != null) ...<Widget>[
          ResumeDraftCard(
            summary: draft,
            // THROUGH `openTradeFormWithTier`, like every other road into the
            // form (#1785). This card pushed `Routes.tradeForm` directly, so a
            // worker the server answered `needs_choice` for went straight into
            // the full walk and never saw the Easy / Medium / Hard chooser
            // (#1698). `pushed` keeps Back returning to "Mere resume", and
            // every answer other than `needs_choice` opens the form exactly as
            // this line did before.
            //
            // `fromStart: true` — the completion walk asks the SAME questions a
            // new candidate answers, from step 1 (employment = work history +
            // qualifications = certificates/education included). Without it the
            // cubit resumes past locally-done markers onto the last unanswered
            // question (e.g. 15/15 machines with only "Submit karein"), so the
            // worker never sees work history / certificates / education again.
            onContinue: () => openTradeFormWithTier(
              context,
              entry: TierEntry.pushed,
              fromStart: true,
            ),
          ),
          const SizedBox(height: 12),
        ],
        const SizedBox(height: 4),
        const _HelpCallout(),
      ],
    );
  }
}

/// The yellow "3 Files" pill on the title line.
class _CountPill extends StatelessWidget {
  const _CountPill({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: OnboardingColors.safetyYellow,
        borderRadius: BorderRadius.circular(OnboardingRadii.badge),
      ),
      child: Text(
        label,
        style: OnboardingTypography.inter(
          size: 12,
          weight: FontWeight.w800,
          color: OnboardingColors.textOnYellow,
        ),
      ),
    );
  }
}

/// "AAPKE SAVED RESUME" with the sync note on the right.
class _ListHeading extends StatelessWidget {
  const _ListHeading();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            kResumeHistoryListLabel.toUpperCase(),
            style: OnboardingTypography.microLabel(),
          ),
        ),
        Text(
          kResumeHistorySyncNote,
          style: OnboardingTypography.inter(
            size: 11,
            weight: FontWeight.w600,
            color: OnboardingColors.ink500,
          ),
        ),
      ],
    );
  }
}

/// The navy "Naya resume banayein" prompt.
///
/// WHERE IT GOES: the Bada Bhai chat. That is the app's REAL "make me another
/// résumé" road — the chat's own résumé menu offers `resume_chat_create`, which
/// mints a fresh session. There is no client-side "generate another" action to
/// wire this to, and inventing one would mean a `POST /resume/generate` that
/// overwrites the current row rather than adding to the history.
class _QuickActionBanner extends StatelessWidget {
  const _QuickActionBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: OnboardingColors.shiftBlue,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.shiftBlueLight),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(
                Icons.add_circle,
                size: 14,
                color: OnboardingColors.safetyYellow,
              ),
              const SizedBox(width: 6),
              Text(
                kResumeQuickActionLabel.toUpperCase(),
                style: OnboardingTypography.inter(
                  size: 10,
                  weight: FontWeight.w800,
                  letterSpacing: 1,
                  color: OnboardingColors.safetyYellow,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            kResumeQuickActionTitle,
            style: OnboardingTypography.anek(
              size: 18,
              weight: FontWeight.w800,
              color: OnboardingColors.textOnBlue,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            kResumeQuickActionBody,
            style: OnboardingTypography.inter(
              size: 12,
              height: 1.45,
              color: OnboardingColors.textOnBlueMuted,
            ),
          ),
          const SizedBox(height: 14),
          // Full width rather than the mock's right-aligned chip: at a large
          // system font the chip's label wrapped to two lines inside a pill,
          // and a CTA that reflows is worse than one that is simply wide.
          ElevatedButton(
            // `go`, NOT `push` (#1783). `/bada-bhai` is the root of the
            // chat branch, and "Mere resume" lives in the PROFILE branch, so a
            // push merged into the profile branch's navigator: it put a SECOND
            // `ChatProfilingScreen` on the profile stack, left the bottom bar
            // on Profile, and — because `ChatBloc` is a `registerFactory` —
            // started a whole separate chat beside the real tab's. The worker
            // then tapped Bada Bhai and found a different conversation from the
            // one they had just been typing in.
            //
            // `go` switches branches, and `StatefulShellRoute` restores the
            // chat branch's OWN stack and its existing `ChatBloc`.
            // `_ShellScaffold._syncActiveTabAfterBuild` is the documented
            // safety net for exactly this — a branch change that did not come
            // from a tab tap — so `TabFocus` follows and the tab still refetches
            // on focus.
            onPressed: () => context.go(Routes.badaBhai),
            style: ElevatedButton.styleFrom(
              backgroundColor: OnboardingColors.safetyYellow,
              foregroundColor: OnboardingColors.textOnYellow,
              elevation: 0,
              minimumSize: const Size(
                double.infinity,
                OnboardingLayout.tapTarget,
              ),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(OnboardingRadii.docked),
              ),
            ),
            child: Text(
              kResumeQuickActionCta,
              style: OnboardingTypography.buttonLabel(
                color: OnboardingColors.textOnYellow,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The support prompt. Opens the app's real Feedback route — the one surface
/// that actually reaches a human here.
class _HelpCallout extends StatelessWidget {
  const _HelpCallout();

  @override
  Widget build(BuildContext context) {
    return Material(
      color: OnboardingColors.infoBg,
      borderRadius: BorderRadius.circular(OnboardingRadii.note),
      child: InkWell(
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        onTap: () => context.pushOnce(
          Routes.feedback,
          extra: GoRouterState.of(context).uri.path,
        ),
        child: Container(
          padding: const EdgeInsets.all(12),
          constraints: const BoxConstraints(
            minHeight: OnboardingLayout.tapTarget,
          ),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(OnboardingRadii.note),
            border: Border.all(color: OnboardingColors.infoBorder),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  color: OnboardingColors.shiftBlue,
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.info_outline_rounded,
                  size: 16,
                  color: OnboardingColors.paperWhite,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      kResumeHelpTitle,
                      style: OnboardingTypography.inter(
                        size: 13,
                        weight: FontWeight.w700,
                        color: OnboardingColors.infoTitle,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      kResumeHelpBody,
                      style: OnboardingTypography.inter(
                        size: 12,
                        height: 1.4,
                        color: OnboardingColors.infoText,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
