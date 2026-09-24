import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_motion.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/education_label.dart';
import '../../../core/util/taxonomy_labels.dart';
import '../../../core/util/trade_key_label.dart';
import '../../../core/widgets/bottom_bar_inset.dart';
import '../../../core/widgets/kit/kit_callout.dart';
import '../../../core/widgets/kit/kit_header_actions.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/questionnaire_bottom_bar.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../../trade_form/domain/trade_form_args.dart';
import '../../trade_form/presentation/open_trade_form.dart';
import '../../profile_tab/domain/profile_summary.dart';
import '../../profile_tab/presentation/widgets/profile_identity_card.dart'
    show profileExperienceLabel;
import '../../trade_form/domain/trade_form_models.dart';
import 'cubit/profile_cubit.dart';
import 'experience_editor_screen.dart';

/// Corner radius of one confirm-row card (Master UI Kit: "white r14 cards").
const double _kConfirmRowRadius = 14;

/// #1524 — the heading of the CHAT-road preview variant, so the form and chat
/// shapes are unmistakably different (and tests can lock which one rendered).
const String kChatProfileHeading = 'Chat se bani profile';

class ProfilePreviewScreen extends StatelessWidget {
  const ProfilePreviewScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ProfileCubit>(
      create: (_) => locator<ProfileCubit>()..extract(),
      child: const _ProfileView(),
    );
  }
}

/// Stateful ONLY to own the bottom-bar measurement for the Feedback FAB inset.
///
/// #1071 — this screen used to sit in a [BbScaffold], which measured its bottom
/// bar and published the height to [bottomBarInset] so the app-wide Feedback
/// FAB (shown on this route) floats clear of the confirm actions. The kit layout
/// needs a raw [Scaffold] (full-bleed Shift Blue header, canvas background, the
/// kit's own docked white bar), so the same measure-and-publish discipline is
/// kept here — copied from `BbScaffold._publishInset`, exactly as
/// `ChatProfilingScreen` does for #1364.
class _ProfileView extends StatefulWidget {
  const _ProfileView();

  @override
  State<_ProfileView> createState() => _ProfileViewState();
}

class _ProfileViewState extends State<_ProfileView> {
  /// Anchors the docked bottom bar so its rendered height can be measured.
  final GlobalKey _bottomBarKey = GlobalKey();

  /// Whether the previous build carried the bottom bar; `null` before the first
  /// build. Mirrors BbScaffold's rule: publish on the first build, then only
  /// while a bar is shown or on the build that removes it — a no-bar → no-bar
  /// rebuild writes nothing.
  bool? _hadBottomBar;

  @override
  void dispose() {
    // This page is leaving; stop claiming its bottom-bar height. DEFERRED to
    // after the frame, same reason as `BbScaffold.dispose`: writing the
    // (listened) notifier synchronously here would markNeedsBuild the FAB
    // overlay mid-build.
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => bottomBarInset.value = 0,
    );
    super.dispose();
  }

  /// Publishes this page's bottom-bar height to [bottomBarInset] (0 when it has
  /// none). The FAB adds the system safe-area inset itself, while
  /// [QuestionnaireBottomBar] paints that inset inside its own box — so it is
  /// subtracted here, keeping the published value "above the safe area" exactly
  /// as BbScaffold's measurement was.
  void _syncBottomInset({required bool hasBar, required double systemInset}) {
    final bool? hadBar = _hadBottomBar;
    _hadBottomBar = hasBar;
    if (hadBar != null && !hasBar && !hadBar) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final double measured = _bottomBarKey.currentContext?.size?.height ?? 0;
      bottomBarInset.value = hasBar ? math.max(0, measured - systemInset) : 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ProfileCubit, ProfileState>(
      // #360: a failed confirm keeps status == ready, so a status-only
      // listenWhen would never announce it. Watch confirmFailure too.
      listenWhen: (prev, curr) =>
          prev.status != curr.status ||
          prev.confirmFailure != curr.confirmFailure,
      listener: (BuildContext context, ProfileState state) {
        if (state.status == ProfileStatus.confirmed) {
          // Profile confirmed AND the route resolved (#1344, SCOPED
          // retirement — full removal of /finishing still waits on broader
          // server-side trade-form coverage + #1338). Route by the server's
          // `next` destination / the trade-form pre-check the cubit already
          // resolved (incl. failing safe to `finishing` on any check error —
          // never left ambiguous here):
          //  - tradeForm → the trade form;
          //  - resume    → résumé building DIRECTLY (chat road, #1528 — never
          //                the trade form and never /finishing);
          //  - finishing → /finishing (#1296), EXACTLY the prior, unconditional
          //                destination. Either form screen collects the
          //                closed-set work-history + preferences, THEN generates
          //                the resume (Building) and enters the shell.
          // context.go clears the onboarding stack (point of no return).
          // #1698 — the trade-form arm may stop at the tier chooser first;
          // the other two are untouched. `unawaited` because this listener
          // cannot be async and the navigation owns itself from here.
          if (state.routeTarget == ProfileRouteTarget.tradeForm) {
            unawaited(
              openTradeFormWithTier(context, entry: TierEntry.replaced),
            );
            return;
          }
          context.go(switch (state.routeTarget) {
            ProfileRouteTarget.tradeForm => Routes.tradeForm,
            ProfileRouteTarget.resume => Routes.building,
            ProfileRouteTarget.finishing || null => Routes.finishing,
          });
          return;
        }
        final Failure? failed = state.confirmFailure;
        if (failed != null) {
          // Say the REAL reason (never a generic "check internet"), and leave
          // the worker on the ready view where retry is one tap.
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(
              SnackBar(content: Text(failureReason(failed).reason)),
            );
        }
      },
      builder: (BuildContext context, ProfileState state) {
        final bool isReady =
            state.status == ProfileStatus.ready ||
            state.status == ProfileStatus.confirmed;
        _syncBottomInset(
          hasBar: isReady,
          systemInset: MediaQuery.paddingOf(context).bottom,
        );
        // Back arrow exactly when the old AppBar implied one (the route can be
        // dismissed), doing exactly what its back button did.
        final bool canGoBack =
            ModalRoute.of(context)?.impliesAppBarDismissal ?? false;
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              ShiftBlueHeader(
                // The ready view asks its question in the header; every other
                // status keeps the screen's plain title.
                title: isReady ? 'Yeh sahi hai?' : 'Your profile',
                subtitle: isReady
                    ? 'Neeche di gayi jaankari confirm karein.'
                    : null,
                onBack: canGoBack ? () => Navigator.maybePop(context) : null,
                // The brand lockup is OFF here, and the Feedback WORD takes its
                // slot. Owner's call on the preparing screen: the worker is
                // watching their own profile being made, and a logo in that
                // corner is not what they need there.
                //
                // This makes the header the screen's ONLY Feedback entry point,
                // so the floating pill is hidden on this route — see
                // `feedback_fab.dart`. Two identical actions on one screen is
                // exactly what that list exists to prevent.
                showBrandBadge: false,
                actions: const <Widget>[KitFeedbackTextAction()],
              ),
              Expanded(
                child: SafeArea(
                  top: false,
                  child: switch (state.status) {
                    ProfileStatus.extracting => _buildWaiting(),
                    // #1344 (scoped) — the brief post-confirm trade-form
                    // pre-check. A plain spinner with no caption, the same
                    // content the shared status view's loading mode showed —
                    // no new status copy is invented for it.
                    ProfileStatus.routing => const _ProgressPanel(),
                    ProfileStatus.failed => _buildFailed(context, state),
                    ProfileStatus.draft => _buildDraft(context),
                    ProfileStatus.ready || ProfileStatus.confirmed =>
                      _buildProfile(context, state),
                  },
                ),
              ),
            ],
          ),
          // Kit 04 CONFIRM actions: [Badlo outline] + [Haan, sahi hai primary],
          // docked outside the scroll. "Badlo" routes back to the chat to change
          // details (the app's edit path); "Haan, sahi hai" confirms + generates
          // the resume. No SUNIE listen button — this screen has no audio.
          bottomNavigationBar: isReady
              ? KeyedSubtree(
                  key: _bottomBarKey,
                  child: QuestionnaireBottomBar(
                    nextLabel: 'Haan, sahi hai',
                    // #360 — on 2G this request can run the full 15s timeout.
                    // An unbound button looked dead, so the worker tapped
                    // repeatedly at the last step of the flow and gave up.
                    isLoading: state.confirming,
                    onNext: context.read<ProfileCubit>().confirm,
                    leading: _SecondaryButton(
                      label: 'Badlo',
                      onPressed: () => _editProfile(context, state.summary),
                    ),
                  ),
                )
              : null,
        );
      },
    );
  }

  Widget _buildWaiting() => const _PreparingPanel();

  Widget _buildFailed(BuildContext context, ProfileState state) {
    return _StatusPanel(
      icon: failureReason(state.failure).icon,
      iconColor: OnboardingColors.errorRed,
      iconBackground: OnboardingColors.errorBg,
      title: 'Profile taiyaar nahi ho payi.',
      subtitle: failureReason(state.failure).reason,
      // TWO ways out, never a dead-end loop. "Try again" re-runs extraction —
      // right for a transient network/server blip. But some failures are
      // DETERMINISTIC on the same transcript (a content-poor interview, an
      // AI-down job that never yields a profile), and re-running would loop
      // forever with no progress. So the worker always has the honest escape:
      // back to chat to add more detail (which #502 redraws intact).
      actions: <Widget>[
        PrimaryActionButton(
          label: 'Try again',
          showArrow: false,
          onPressed: context.read<ProfileCubit>().extract,
        ),
        const SizedBox(height: 12),
        _SecondaryButton(
          label: 'Chat pe wapas jaayein',
          icon: Icons.chat_bubble_outline,
          expand: true,
          onPressed: () => _backToChat(context),
        ),
      ],
    );
  }

  /// The extraction produced too little to be a usable profile (backend
  /// `profile_status == 'draft'`, TD81/#503). Do NOT show the Confirm CTA — a
  /// draft confirmed becomes a near-empty resume. Be honest about why, and route
  /// the worker back to chat to say more (their transcript is redrawn by #502).
  Widget _buildDraft(BuildContext context) {
    return _StatusPanel(
      icon: Icons.edit_note_outlined,
      iconColor: OnboardingColors.shiftBlue,
      iconBackground: OnboardingColors.cardIconBg,
      title: 'Thodi aur detail chahiye.',
      subtitle:
          'Bada Bhai aapki poori profile banane ke liye thoda aur jaanna '
          'chahta hai. Chaliye do-teen baatein aur bata dijiye.',
      actions: <Widget>[
        PrimaryActionButton(
          label: 'Chat pe wapas jaayein',
          showArrow: false,
          onPressed: () => _backToChat(context),
        ),
      ],
    );
  }

  /// Returns the worker to the profiling chat. Prefer a pop (keeps the live chat
  /// bloc + its in-memory transcript, no flicker); fall back to a route change
  /// when this screen was not reached by a push (chat then re-mounts and #502
  /// redraws the transcript from the server).
  void _backToChat(BuildContext context) {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go(Routes.chatProfiling);
    }
  }

  /// #1524 — "Badlo" (and a row's edit glyph) returns the worker to the flow
  /// that ORIGINATED their profile:
  ///  - form road (`source == 'form'`) → the trade form;
  ///  - chat road (`source == 'chat'`) and unknown (`null`) → the chat, exactly
  ///    today's behaviour (pop back to the live chat when possible).
  void _editProfile(BuildContext context, ProfileSummary? summary) {
    if (summary?.isFormSourced ?? false) {
      // #1698 — same gate. In practice a worker editing an EXISTING
      // form-sourced profile has already chosen a tier, so the server answers
      // `needs_choice: false` and this is today's `go` — but the decision is
      // the server's to make, not this screen's to assume.
      unawaited(openTradeFormWithTier(context, entry: TierEntry.replaced));
      return;
    }
    _backToChat(context);
  }

  /// Renders the REAL extracted profile read back from the summary route, as the
  /// kit 04 CONFIRM content: the "Yeh sahi hai?" question lives in the header,
  /// over one card per label→value fact, each editable card carrying an edit
  /// glyph (tap → back to chat to change it). Every value is actual data or an
  /// honest "being finalised" note — never a fabricated placeholder (the worker
  /// confirms what they can actually see).
  Widget _buildProfile(BuildContext context, ProfileState state) {
    final ProfileSummary? summary = state.summary;
    // #1524 — the chat road gets its own visibly distinct variant. The form
    // road and the unknown (`null`) road keep today's exact rendering.
    if (summary != null && summary.isChatSourced) {
      return _buildChatProfile(context, summary, state.employments);
    }
    final List<Widget> rows = <Widget>[];
    if (summary == null) {
      // Extraction succeeded but the summary read missed. Be honest — no fake
      // rows — and still let the worker confirm (the profile does exist).
      rows.add(const _ConfirmRow(label: 'Profile', value: 'Ready'));
    } else {
      final String trade = _tradeText(summary) ?? 'Tayyar ho raha hai…';
      final String? city = (summary.city?.isNotEmpty ?? false)
          ? summary.city
          : null;
      // PII-free education labels — shown only when present, never fabricated.
      final String? education = _educationLabel(summary);

      // The data facts the worker confirms (each editable via chat). The
      // "Profile strength" row was removed here (#844): a completeness score is
      // not an input to "is this correct?", and a low number reads like a failing
      // grade at the moment we want a simple yes. `strength*` stay on
      // ProfileSummary — other screens still use them; this screen just no longer
      // renders the row.
      final List<({String label, String value, bool editable})> specs =
          <({String label, String value, bool editable})>[
            (label: 'Trade', value: trade, editable: true),
            if (city != null) (label: 'City', value: city, editable: true),
            if (education != null)
              (label: 'Education', value: education, editable: true),
          ];
      for (final ({String label, String value, bool editable}) s in specs) {
        rows.add(
          _ConfirmRow(
            label: s.label,
            value: s.value,
            onEdit: s.editable ? () => _editProfile(context, summary) : null,
          ),
        );
      }
    }

    return OnboardingBody(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          for (int i = 0; i < rows.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 10),
            rows[i],
          ],
          if (summary == null) ...<Widget>[
            const SizedBox(height: 12),
            Text(
              'Details abhi dikh nahi paa rahe — aap confirm karke aage badh sakte hain.',
              style: OnboardingTypography.bodyMuted(),
            ),
          ],
        ],
      ),
    );
  }

  /// #1524 — the CHAT-road confirm variant. Same kit 04 card shape, but its
  /// facts are the ones a chat interview actually yields — the extracted
  /// occupation, chat experience / education and the skills the worker named —
  /// and a chat-road heading sets it apart from the form's Trade/City/Education
  /// sheet (the two are never silently mixed). Every value is real or an honest
  /// "being finalised" note; nothing is fabricated.
  Widget _buildChatProfile(
    BuildContext context,
    ProfileSummary summary,
    List<TradeFormEmploymentEntry> employments,
  ) {
    final String occupation = _tradeText(summary) ?? 'Tayyar ho raha hai…';
    final double? years = summary.experienceYears;
    final String? experience =
        years == null ? null : profileExperienceLabel(years);
    final String? education = _educationLabel(summary);
    final String? skills =
        summary.skills.isEmpty ? null : summary.skills.map(replaceTaxonomyIds).join(', ');

    final List<({String label, String value})> specs =
        <({String label, String value})>[
          (label: 'Kaam', value: occupation),
          if (experience != null) (label: 'Anubhav', value: experience),
          if (education != null) (label: 'Padhai', value: education),
          if (skills != null) (label: 'Skills', value: skills),
        ];

    return OnboardingBody(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const _ChatSourceHeading(),
          const SizedBox(height: 12),
          for (int i = 0; i < specs.length; i++) ...<Widget>[
            if (i > 0) const SizedBox(height: 10),
            _ConfirmRow(
              label: specs[i].label,
              value: specs[i].value,
              onEdit: () => _editProfile(context, summary),
            ),
          ],
          // #issue5 — the chat road told the truth about ONE aggregate
          // "Anubhav" and stopped there, so a worker with two or three jobs had
          // no way to record them. The form's repeated-card editor is reused
          // (same validation, same endpoint) and every added row is shown here
          // so the write is never blind — tapping a row reopens the editor.
          for (final TradeFormEmploymentEntry e in employments) ...<Widget>[
            const SizedBox(height: 10),
            _ConfirmRow(
              label: 'Kaam ki jagah',
              value: _employmentLine(e),
              onEdit: () => _openExperienceEditor(context, employments),
            ),
          ],
          const SizedBox(height: 14),
          _SecondaryButton(
            label: 'Aur anubhav jodein',
            icon: Icons.add,
            expand: true,
            onPressed: () => _openExperienceEditor(context, employments),
          ),
        ],
      ),
    );
  }

  /// #issue5 — opens the reused form employment editor over this screen. The
  /// live [ProfileCubit] is re-provided to the pushed route (it sits above the
  /// app's Navigator, so the route does not inherit it), letting the editor
  /// save and the confirm screen rebuild with the new rows.
  Future<void> _openExperienceEditor(
    BuildContext context,
    List<TradeFormEmploymentEntry> employments,
  ) async {
    final ProfileCubit cubit = context.read<ProfileCubit>();
    await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => BlocProvider<ProfileCubit>.value(
          value: cubit,
          child: ExperienceEditorScreen(
            initialEntries: employments,
            loadOptions: cubit.loadEmploymentOptions,
            onSave: cubit.saveEmployments,
          ),
        ),
      ),
    );
  }
}

/// #issue5 — one banked work-history row as a single confirm line:
/// "Sandhar · Operator · Mar 2020 – abhi". Missing pieces are simply dropped;
/// nothing is invented for a field the worker left out.
String _employmentLine(TradeFormEmploymentEntry e) {
  final String employer = e.employerName.trim();
  final String role = e.roleLabel.trim();
  final String when = _employmentWhen(e);
  final String head = role.isEmpty ? employer : '$employer · $role';
  return when.isEmpty ? head : '$head · $when';
}

/// "Mar 2020 – Feb 2023", "Mar 2020 – abhi", or "" when both ends are absent.
String _employmentWhen(TradeFormEmploymentEntry e) {
  final String? start = _shortYearMonth(e.startYm);
  final String? end = e.stillWorking ? 'abhi' : _shortYearMonth(e.endYm);
  if (start == null) return end ?? '';
  if (end == null) return start;
  return '$start – $end';
}

const List<String> _kShortMonths = <String>[
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// "2023-03" → "Mar 2023"; null/unparsable returns null so the caller can drop
/// the segment rather than print a raw id-shaped value.
String? _shortYearMonth(String? ym) {
  if (ym == null) return null;
  final List<String> parts = ym.split('-');
  if (parts.length != 2) return null;
  final int? month = int.tryParse(parts[1]);
  if (month == null || month < 1 || month > 12) return null;
  return '${_kShortMonths[month - 1]} ${parts[0]}';
}

/// #1524 — the chat-road marker on the confirm variant: a chat glyph plus the
/// [kChatProfileHeading] line, so a chat profile can never be mistaken for the
/// form road's trade sheet.
class _ChatSourceHeading extends StatelessWidget {
  const _ChatSourceHeading();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        const Icon(
          Icons.chat_bubble_outline,
          size: 18,
          color: OnboardingColors.shiftBlue,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            kChatProfileHeading,
            style: OnboardingTypography.microLabel(
              color: OnboardingColors.ink600,
            ),
          ),
        ),
      ],
    );
  }
}

/// The trade line, guaranteed worker-readable (D11: no raw id, slug or enum
/// ever reaches a screen).
///
/// `trade.display_name` is normally already a label ('Welder', 'CNC operator
/// and VMC setter'), and a label is returned UNTOUCHED — re-casing a real
/// sentence would mangle it. Only a token-shaped value is humanised
/// (`cnc_turner` → 'CNC Turner'), and an INTERNAL id (`role_welder`,
/// `mskill_*`) returns null so the caller shows the honest "being finalised"
/// line instead of an id the worker cannot read.
String? _tradeText(ProfileSummary summary) {
  final String raw = summary.tradeLabel?.trim() ?? '';
  if (raw.isEmpty) return null;
  if (!raw.contains('_')) return raw;
  final String label = tradeKeyLabel(raw);
  return label.isEmpty ? null : label;
}

/// "12th • Electronics" / "12th" / "Electronics"; `null` when both are absent so
/// the preview row is omitted entirely. PII-free labels, never fabricated.
String? _educationLabel(ProfileSummary s) {
  final List<String> parts = <String>[
    if (s.educationLevel?.isNotEmpty ?? false)
      humanizeEducationLevel(s.educationLevel!),
    if (s.educationField?.isNotEmpty ?? false) s.educationField!,
  ];
  return parts.isEmpty ? null : parts.join(' • ');
}

/// One kit 04 CONFIRM fact as its own white r14 card with a `borderDefault`
/// hairline: the `label` as a field micro-label over the `value`, with an
/// optional edit glyph. When [onEdit] is set the whole card is the tap target
/// (≥48px), routing back to the chat to change the fact.
class _ConfirmRow extends StatelessWidget {
  const _ConfirmRow({required this.label, required this.value, this.onEdit});

  final String label;
  final String value;
  final VoidCallback? onEdit;

  @override
  Widget build(BuildContext context) {
    final Widget content = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: OnboardingLayout.tapTarget),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  // UPPERCASED at the display edge, like every other §1.2
                  // field micro-label in the app ('MOBILE NUMBER', 'PEHLA
                  // NAAM', 'AAPKI BAAT'). Title Case here made the one screen
                  // that confirms a worker's own facts read as a different
                  // form family.
                  Text(
                    label.toUpperCase(),
                    style: OnboardingTypography.fieldMicroLabel(),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    value,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.inter(
                      size: 16,
                      weight: FontWeight.w600,
                      height: 1.3,
                    ),
                  ),
                ],
              ),
            ),
            if (onEdit != null) ...<Widget>[
              const SizedBox(width: 12),
              const Icon(
                Icons.edit,
                size: 18,
                color: OnboardingColors.shiftBlue,
              ),
            ],
          ],
        ),
      ),
    );

    return Material(
      color: OnboardingColors.paperWhite,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(_kConfirmRowRadius),
        side: const BorderSide(color: OnboardingColors.borderDefault),
      ),
      child: onEdit == null ? content : InkWell(onTap: onEdit, child: content),
    );
  }
}

/// The kit's white outlined secondary action ([KitButtonStyles.outline]): navy
/// border, r12, 48px tall, navy Anek label (and optional leading icon). Sized
/// to its label unless
/// [expand], so it can sit as [QuestionnaireBottomBar.leading] beside the yellow
/// next button.
class _SecondaryButton extends StatelessWidget {
  const _SecondaryButton({
    required this.label,
    required this.onPressed,
    this.icon,
    this.expand = false,
  });

  final String label;
  final VoidCallback onPressed;
  final IconData? icon;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: SizedBox(
        height: OnboardingLayout.tapTarget,
        width: expand ? double.infinity : null,
        child: OutlinedButton(
          // Same light haptic the replaced BbButton fired on every variant.
          onPressed: () {
            HapticFeedback.lightImpact();
            onPressed();
          },
          // The shared v3 outline paint (white fill, navy 1.5 border, navy
          // Anek label, r12, 48dp floor) — one source, so this button cannot
          // drift from the yellow next button it sits beside.
          style: KitButtonStyles.outline,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (icon != null) ...<Widget>[
                  Icon(icon, size: 20, color: OnboardingColors.shiftBlue),
                  const SizedBox(width: 8),
                ],
                Text(label, style: OnboardingTypography.buttonLabel()),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A centred shiftBlue spinner with an optional [title] and [caption] beneath —
/// the extracting and routing views. Scrolls, so a large system font on a small
/// phone never overflows.
/// The extraction wait's headline and subline.
///
/// Public so a test can pin the copy without re-typing it.
const String kPreparingProfileTitle = 'Bada Bhai is preparing your profile…';
const String kPreparingProfileCaption =
    'This takes a few seconds. Please wait while we curate your tailored '
    'experience.';

/// The tip under the ticker — a real, checkable statement about this app:
/// everything on the profile can be changed later from Settings.
const String kPreparingProfileTipTitle = 'Quick tip';
const String kPreparingProfileTipText =
    'You can change your details, privacy settings and notifications anytime '
    'from account preferences.';

/// The three rows of the preparation ticker, in order.
const List<String> kPreparingProfileSteps = <String>[
  'Verifying account credentials',
  'Customizing recommendations',
  'Finalizing profile sync',
];

/// The state of one ticker row, derived from the paced step.
enum _StepState { done, live, pending }

/// The `extracting` surface: a pulsing avatar, the headline + subline, a white
/// three-row progress card and one quick tip.
///
/// Replaces the bare spinner this state used to show. The extraction is ONE
/// opaque server call — there is no per-step signal on the wire — so the ticker
/// is a PACED client-side drawing, exactly like the resume-building screen's
/// (kit 22) and under the same rule: it never runs to "all done". The pacing
/// stops inside the second row, and the screen leaves on the cubit's state
/// change, never on a timer.
class _PreparingPanel extends StatefulWidget {
  const _PreparingPanel();

  @override
  State<_PreparingPanel> createState() => _PreparingPanelState();
}

class _PreparingPanelState extends State<_PreparingPanel>
    with SingleTickerProviderStateMixin {
  /// The avatar's ripple. REPEATS for as long as this panel is up: the wait has
  /// no known end, and a one-shot would freeze mid-wait and read as a hang.
  ///
  /// It is the only looping animation here — the ticker and the row entrance
  /// are finite tweens. A widget test must therefore `pump(duration)` and never
  /// `pumpAndSettle` while this panel is on screen. That is not a new rule: the
  /// bare `CircularProgressIndicator` it replaces looped just the same, which is
  /// why the existing tests already step the extracting state with `pump()`.
  late final AnimationController _ripple = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 2),
  )..repeat();

  @override
  void dispose() {
    _ripple.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        const Positioned.fill(child: _TopGlow()),
        _CentredBody(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              _PulseAvatar(ripple: _ripple),
              const SizedBox(height: 26),
              Text(
                kPreparingProfileTitle,
                textAlign: TextAlign.center,
                style: OnboardingTypography.questionHeadline(
                  color: OnboardingColors.shiftBlue,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                kPreparingProfileCaption,
                textAlign: TextAlign.center,
                style: OnboardingTypography.bodyMuted(),
              ),
              const SizedBox(height: 24),
              const _PrepareTicker(),
              const SizedBox(height: 16),
              const _QuickTip(),
            ],
          ),
        ),
      ],
    );
  }
}

/// The design's top-centred radial glow: a whisper of navy over the canvas.
/// Decoration only — no hit test, nothing for a screen reader.
class _TopGlow extends StatelessWidget {
  const _TopGlow();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: ExcludeSemantics(
        child: DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              center: const Alignment(0, -0.95),
              radius: 0.9,
              colors: <Color>[
                OnboardingColors.shiftBlue.withValues(alpha: 0.07),
                OnboardingColors.shiftBlue.withValues(alpha: 0),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The hero: the worker's own profile mark, breathing in the brand's two
/// colours while the server works.
///
/// Drawn rather than photographic on purpose — there is no worker photo at this
/// point in onboarding (the profile is still being extracted), so a real avatar
/// would be a placeholder pretending to be data.
///
/// The colour animation is the POINT of this widget, not decoration on top of
/// it: it is the only thing on the screen that proves the app is alive during a
/// wait with no progress to report. So it is deliberately loud — two ripples
/// leaving the disc half a cycle apart, each travelling navy → safety yellow as
/// it goes, over a glow that breathes with them, and a disc outline that cycles
/// between the same two colours.
///
/// The PERSON GLYPH itself stays navy at all times. It is the one element that
/// has to stay readable, and a mid-cycle yellow on white drops it to roughly
/// 2:1 contrast.
///
/// Decorative to a screen reader — the headline beneath already says what is
/// happening, so nothing here is announced.
class _PulseAvatar extends StatelessWidget {
  const _PulseAvatar({required this.ripple});

  /// 0 → 1, repeating. Drives every colour, scale and alpha below.
  final Animation<double> ripple;

  /// The box, which is also a ripple's widest drawing.
  static const double _box = 140;

  /// The avatar disc, and therefore where a ripple is born (`_disc / _box`).
  static const double _disc = 92;

  static const double _birth = _disc / _box;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox(
        width: _box,
        height: _box,
        child: AnimatedBuilder(
          animation: ripple,
          builder: (BuildContext context, _) {
            final double t = ripple.value;
            // 0 → 1 → 0 across one cycle, so the disc BREATHES instead of
            // snapping back to navy at the wrap.
            final double wave = 0.5 - 0.5 * math.cos(2 * math.pi * t);
            return Stack(
              alignment: Alignment.center,
              children: <Widget>[
                _glow(wave),
                // Half a cycle apart, so a ring is always in flight.
                _ring((t + 0.5) % 1),
                _ring(t),
                _face(wave),
              ],
            );
          },
        ),
      ),
    );
  }

  /// One ripple at [phase] of its life: it leaves the disc's edge, grows to the
  /// full box, warms from navy to safety yellow and fades out.
  Widget _ring(double phase) {
    final Color colour = Color.lerp(
      OnboardingColors.shiftBlue,
      OnboardingColors.safetyYellow,
      phase,
    )!;
    return Transform.scale(
      scale: _birth + (1 - _birth) * phase,
      child: Container(
        width: _box,
        height: _box,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(
            color: colour.withValues(alpha: (1 - phase) * 0.85),
            width: 3,
          ),
        ),
      ),
    );
  }

  /// The warm halo hugging the disc, brightest at the top of the breath.
  Widget _glow(double wave) {
    return Container(
      width: _disc + 26,
      height: _disc + 26,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: <Color>[
            OnboardingColors.safetyYellow.withValues(alpha: 0.10 + 0.22 * wave),
            OnboardingColors.safetyYellow.withValues(alpha: 0),
          ],
        ),
      ),
    );
  }

  /// The disc itself: a tint that deepens with the breath, an outline cycling
  /// navy → yellow, and the constant navy person glyph.
  Widget _face(double wave) {
    return Container(
      width: _disc,
      height: _disc,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Color.lerp(
          OnboardingColors.paperWhite,
          OnboardingColors.shieldCircle,
          wave,
        ),
        shape: BoxShape.circle,
        border: Border.all(
          color: Color.lerp(
            OnboardingColors.shiftBlue,
            OnboardingColors.safetyYellow,
            wave,
          )!,
          width: 2.5,
        ),
      ),
      child: const Icon(
        Icons.person_outline_rounded,
        size: 44,
        color: OnboardingColors.shiftBlue,
      ),
    );
  }
}

/// The paced ticker. ONE finite tween drives both the staggered entrance and
/// which row is live, so there is no second animation to keep in step.
class _PrepareTicker extends StatelessWidget {
  const _PrepareTicker();

  /// The pacing ceiling. `floor(0.66 * 3) == 1`, so the LAST row is never
  /// reached and the card never claims the profile is finished.
  static const double _pacedTo = 0.66;

  /// How much faster the entrance runs than the pacing, and the per-row offset
  /// within it — row `i` finishes appearing at `t == (i * _stagger + 1) / _rush`.
  static const double _rush = 5;
  static const double _stagger = 0.6;

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: AppMotion.slower * 5, // ~2.4s across the first two rows
      curve: AppMotion.easeInOut,
      builder: (BuildContext context, double t, _) {
        final int live = (t * _pacedTo * kPreparingProfileSteps.length)
            .clamp(0, kPreparingProfileSteps.length - 1)
            .floor();
        return Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
          decoration: BoxDecoration(
            color: OnboardingColors.paperWhite,
            borderRadius: BorderRadius.circular(OnboardingRadii.card),
            border: Border.all(color: OnboardingColors.borderSubtle),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              for (int i = 0; i < kPreparingProfileSteps.length; i++)
                _PrepareStepRow(
                  label: kPreparingProfileSteps[i],
                  state: i < live
                      ? _StepState.done
                      : (i == live ? _StepState.live : _StepState.pending),
                  reveal: ((t * _rush) - i * _stagger).clamp(0.0, 1.0),
                ),
            ],
          ),
        );
      },
    );
  }
}

/// One ticker row: the state indicator and the label, faded and slid up by
/// [reveal] on entry.
class _PrepareStepRow extends StatelessWidget {
  const _PrepareStepRow({
    required this.label,
    required this.state,
    required this.reveal,
  });

  final String label;
  final _StepState state;

  /// 0 (not yet shown) → 1 (in place).
  final double reveal;

  @override
  Widget build(BuildContext context) {
    final bool pending = state == _StepState.pending;
    return Opacity(
      opacity: reveal,
      child: Transform.translate(
        offset: Offset(0, 8 * (1 - reveal)),
        child: MergeSemantics(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Row(
              children: <Widget>[
                SizedBox(width: 22, height: 22, child: _indicator()),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    label,
                    style: OnboardingTypography.inter(
                      size: 13,
                      weight: state == _StepState.live
                          ? FontWeight.w700
                          : FontWeight.w500,
                      height: 1.35,
                      color: pending
                          ? OnboardingColors.ink500
                          : OnboardingColors.ink900,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _indicator() {
    switch (state) {
      case _StepState.done:
        return Container(
          decoration: const BoxDecoration(
            color: OnboardingColors.successBg,
            shape: BoxShape.circle,
          ),
          child: const Icon(
            Icons.check_rounded,
            size: 15,
            color: OnboardingColors.successGreen,
            semanticLabel: 'Done',
          ),
        );
      case _StepState.live:
        return const Padding(
          padding: EdgeInsets.all(2.5),
          child: CircularProgressIndicator(
            strokeWidth: 2.5,
            color: OnboardingColors.shiftBlue,
          ),
        );
      case _StepState.pending:
        return Container(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(
              color: OnboardingColors.borderDefault,
              width: 1.5,
            ),
          ),
        );
    }
  }
}

/// The tip panel: the kit's informational callout, carrying a round glyph disc
/// instead of the callout's square navy tile (the design draws it round).
class _QuickTip extends StatelessWidget {
  const _QuickTip();

  @override
  Widget build(BuildContext context) {
    return KitCallout(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: OnboardingColors.paperWhite,
              shape: BoxShape.circle,
              border: Border.all(color: OnboardingColors.infoBorder),
            ),
            child: const Icon(
              Icons.info_outline_rounded,
              size: 16,
              color: OnboardingColors.infoTitle,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  kPreparingProfileTipTitle.toUpperCase(),
                  style: OnboardingTypography.inter(
                    size: 10,
                    weight: FontWeight.w800,
                    letterSpacing: 0.8,
                    color: OnboardingColors.infoTitle,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  kPreparingProfileTipText,
                  style: OnboardingTypography.inter(
                    size: 12,
                    weight: FontWeight.w600,
                    height: 1.4,
                    color: OnboardingColors.infoText,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ProgressPanel extends StatelessWidget {
  const _ProgressPanel();

  @override
  Widget build(BuildContext context) {
    return const _CentredBody(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          CircularProgressIndicator(
            color: OnboardingColors.shiftBlue,
            strokeWidth: 3,
          ),
        ],
      ),
    );
  }
}

/// Vertically centres a short panel, scrolls a tall one, and caps the column at
/// [OnboardingLayout.maxContentWidth] on a tablet or a landscape phone.
///
/// NOT [OnboardingBody]`(fillViewport: true)`, deliberately — the same reason
/// the voice-note screen records. That widget reaches the contract through an
/// [IntrinsicHeight], which exists so a column of `Spacer`s can centre on a
/// tall screen; intrinsics cannot be measured through a [LayoutBuilder], and
/// these panels contain them. Nothing here uses a `Spacer`, so a [Column]
/// inside a `minHeight` box already sizes to `max(its content, the viewport)`.
class _CentredBody extends StatelessWidget {
  const _CentredBody({required this.child});

  static const EdgeInsets _padding = EdgeInsets.all(20);

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double minHeight = constraints.maxHeight.isFinite
            ? math.max(0, constraints.maxHeight - _padding.vertical)
            : 0.0;
        return SingleChildScrollView(
          padding: _padding,
          child: Center(
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minHeight: minHeight,
                maxWidth: OnboardingLayout.maxContentWidth,
              ),
              child: child,
            ),
          ),
        );
      },
    );
  }
}

/// A centred icon disc + title + subtitle + actions — the failed and draft
/// views, in kit colours. Scrolls, so it never overflows on a small phone.
class _StatusPanel extends StatelessWidget {
  const _StatusPanel({
    required this.icon,
    required this.iconColor,
    required this.iconBackground,
    required this.title,
    required this.subtitle,
    required this.actions,
  });

  final IconData icon;
  final Color iconColor;
  final Color iconBackground;
  final String title;
  final String subtitle;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    return _CentredBody(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Center(
            child: Container(
              // The kit's status disc (D12 / [BbStatusView]): 54 with a 28dp
              // glyph, so a status view reads the same size everywhere.
              width: 54,
              height: 54,
              decoration: BoxDecoration(
                color: iconBackground,
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 28, color: iconColor),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            title,
            textAlign: TextAlign.center,
            style: OnboardingTypography.questionHeadline(
              color: OnboardingColors.shiftBlue,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            subtitle,
            textAlign: TextAlign.center,
            style: OnboardingTypography.body(color: OnboardingColors.ink600),
          ),
          const SizedBox(height: 24),
          ...actions,
        ],
      ),
    );
  }
}
