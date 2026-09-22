import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/job_display.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_check_row.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_docked_bar.dart';
import '../../../core/widgets/kit/kit_info_chip.dart';
import '../../../core/widgets/kit/kit_micro_label.dart';
import '../../../core/widgets/kit/kit_pill.dart';
import '../../../core/widgets/kit/kit_salary_box.dart';
import '../../../core/widgets/kit/kit_square_icon_button.dart';
import '../../../core/widgets/onboarding/questionnaire_bottom_bar.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../domain/job_detail.dart';
import '../domain/jobs_repository.dart';
import '../domain/swipe_repository.dart';
import 'cubit/job_detail_cubit.dart';
import '../../../core/widgets/feedback_fab.dart';

/// TalkBack label for the icon-only sticky close button (#375).
const String kCloseSemanticLabel = 'Band karein';

/// Full job posting. A navy [ShiftBlueHeader] carries the title and the place,
/// then the green salary box and one [KitCard] per section (the coarse facts,
/// the description, ZAROORI SKILLS, BENEFITS), with a docked "Apply karein" bar
/// pinned at the bottom.
///
/// Reached full-screen from a Feed card (or an Applied row), which hands over the
/// light [JobDetail] it already holds — the header renders instantly from it
/// while the FULL worker-visible posting is fetched from `GET /jobs/:jobId` (the
/// ADR-0024 addendum, 2026-07-16). Applying goes through the same path as the
/// Feed.
///
/// Shows ONLY what the backend actually returns; each row renders ONLY when its
/// field is non-null (a null field HIDES its row, never a placeholder), and a
/// section with no data is not rendered at all. EMPLOYER IDENTITY IS HIDDEN
/// ENTIRELY per the addendum ruling: no company name, no masked descriptor, no
/// verified badge, no HOT tag, no spots-left, no fabricated "match %" — nothing
/// employer-shaped and nothing scored (LLMs never rank, CLAUDE.md §4). An
/// earlier build invented all of that client-side from `jobId.hashCode`;
/// nothing here is synthesised.
class JobDetailScreen extends StatelessWidget {
  const JobDetailScreen({super.key, required this.detail, this.cubit});

  /// The light detail from the tapped row (instant header render).
  final JobDetail detail;

  /// Test seam: inject a [JobDetailCubit] over a real repository + MockClient
  /// (mirrors [SwipeJobsScreen.bloc]).
  final JobDetailCubit? cubit;

  @override
  Widget build(BuildContext context) {
    final JobDetailCubit? injected = cubit;
    if (injected != null) {
      return BlocProvider<JobDetailCubit>.value(
        value: injected,
        child: const _JobDetailView(),
      );
    }
    return BlocProvider<JobDetailCubit>(
      create: (_) => JobDetailCubit(
        locator<JobsRepository>(),
        locator<SwipeRepository>(),
        detail,
      ),
      child: const _JobDetailView(),
    );
  }
}

class _JobDetailView extends StatefulWidget {
  const _JobDetailView();

  @override
  State<_JobDetailView> createState() => _JobDetailViewState();
}

class _JobDetailViewState extends State<_JobDetailView> {
  int _shownApplied = 0;
  int _shownError = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: BlocConsumer<JobDetailCubit, JobDetailState>(
        listenWhen: (JobDetailState p, JobDetailState c) =>
            p.appliedNonce != c.appliedNonce ||
            p.applyErrorNonce != c.applyErrorNonce,
        listener: (BuildContext context, JobDetailState state) {
          if (state.appliedNonce != _shownApplied) {
            _shownApplied = state.appliedNonce;
            // Pop back to the Jobs feed with a result so it surfaces an
            // "Applied" toast.
            context.pop('applied');
          } else if (state.applyErrorNonce != _shownError) {
            _shownError = state.applyErrorNonce;
            ScaffoldMessenger.of(context)
              ..clearSnackBars()
              ..showSnackBar(
                const SnackBar(
                  content: Text('Could not apply. Please try again.'),
                ),
              );
          }
        },
        builder: (BuildContext context, JobDetailState state) =>
            _detail(context, state),
      ),
    );
  }

  Widget _detail(BuildContext context, JobDetailState state) {
    final JobDetail d = state.detail;
    final double width = MediaQuery.sizeOf(context).width;
    return Column(
      children: <Widget>[
        // The place rides the header subtitle, so it is on screen the instant
        // the row hands over — and it is NOT repeated as a fact chip below.
        ShiftBlueHeader(
          title: d.title,
          subtitle: d.place,
          onBack: () => context.pop(),
          // The detail body is a 600 list — header, body and the docked Apply
          // bar all stop on the same line.
          maxWidth: OnboardingLayout.maxTabContentWidth,
        ),
        Expanded(
          child: ListView(
            padding: KitInsets.list(
              width,
              gutter: 16,
            ).copyWith(
              top: 14,
              // Plus the floating Feedback pill's band, which otherwise landed
              // on a skill chip. See [FeedbackFabInset].
              bottom: 14 + FeedbackFabInset.of(context),
            ),
            children: _spaced(_blocks(context, state)),
          ),
        ),
        _bottomBar(context, state),
      ],
    );
  }

  /// The body's blocks, in order, each present ONLY when it has real data.
  List<Widget> _blocks(BuildContext context, JobDetailState state) {
    final JobDetail d = state.detail;
    final List<Widget> blocks = <Widget>[];

    // The employer's OFFERED band — hence 'Salary', not 'Expected salary'
    // (that label belongs to the worker's own asking figure on the resume).
    final String? pay = formatPayBandFull(d.payMin, d.payMax);
    if (pay != null) {
      // The poster's own pay-type wording joins the label when they stated it
      // (#1648) — "Salary — IN-HAND". Unstated stays the bare 'Salary': the
      // screen never tells a man a band is his take-home on no evidence.
      final String? payType = payTypeLabel(d.payType);
      blocks.add(
        KitSalaryBox(
          label: payType == null ? 'Salary' : 'Salary — $payType',
          value: pay,
        ),
      );
    }

    final List<Widget> facts = _factChips(d);
    if (facts.isNotEmpty) {
      blocks.add(
        KitCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const KitMicroLabel('KAAM KI JAANKARI'),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: facts),
            ],
          ),
        ),
      );
    }

    if (state.loading) {
      blocks.add(_loading());
    } else {
      if (state.loadFailed) blocks.add(_loadFailedNote(context));
      blocks.addAll(_sections(d));
    }
    return blocks;
  }

  /// The coarse facts, each rendered ONLY when its field is non-null (a null
  /// field hides its chip — never fabricated). Order per the ADR-0024 addendum:
  /// shift, experience, needed-by. The place is in the header.
  ///
  /// A NEUTRAL dot and NO green check: the tick in this kit means "verified",
  /// and a job's stated shift is the employer's claim, not a checked fact.
  List<Widget> _factChips(JobDetail d) {
    final List<Widget> chips = <Widget>[];
    final String? shift = shiftLabel(d.shift);
    if (shift != null) chips.add(_fact('$shift shift'));
    final String? experience = experienceLabel(
      d.minExperienceYears,
      d.maxExperienceYears,
    );
    if (experience != null) chips.add(_fact(experience));
    final String? neededBy = neededByLabel(d.neededBy);
    if (neededBy != null) chips.add(_fact(neededBy));
    return chips;
  }

  Widget _fact(String label) =>
      KitInfoChip(label: label, dot: OnboardingColors.ink500, showCheck: false);

  /// Fetch-phase indicator below the instantly-rendered header. A captioned
  /// spinner, never a bare centered one (design spec §5 / §10).
  Widget _loading() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: OnboardingColors.shiftBlue,
            ),
          ),
          const SizedBox(width: 12),
          // Flexible: the caption is a whole sentence, and a 320dp card at a
          // 2.0 system font has nowhere near the width for it on one line. It
          // wraps beside the spinner instead of running off the card.
          Flexible(
            child: Text(
              'Poori jaankari load ho rahi hai…',
              style: OnboardingTypography.body(color: OnboardingColors.ink600),
            ),
          ),
        ],
      ),
    );
  }

  /// Quiet retry affordance: the header above stays — what we have is real —
  /// only the FULL posting failed to load.
  Widget _loadFailedNote(BuildContext context) {
    // A Wrap, not a Row: at a large system font the sentence and the button
    // cannot share a 320dp line, and "Try again" is the one control on this
    // block — it drops under the sentence rather than being squeezed away.
    return SizedBox(
      width: double.infinity,
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: <Widget>[
          Text(
            'Poori jaankari load nahi hui.',
            style: OnboardingTypography.body(color: OnboardingColors.ink600),
          ),
          TextButton(
            style: TextButton.styleFrom(
              minimumSize: const Size(
                OnboardingLayout.tapTarget,
                OnboardingLayout.tapTarget,
              ),
            ),
            onPressed: () => context.read<JobDetailCubit>().retry(),
            child: const Text('Try again'),
          ),
        ],
      ),
    );
  }

  /// The narrative sections, each rendered ONLY when its field is non-null (a
  /// null field hides the whole card). The coarse facts live in their own card
  /// above, so this is description → ZAROORI SKILLS → BENEFITS only.
  List<Widget> _sections(JobDetail d) {
    final List<String>? requirements = d.requirements;
    final List<String>? benefits = d.benefits;
    final List<Widget> out = <Widget>[];

    if (d.description != null && d.description!.trim().isNotEmpty) {
      out.add(
        _sectionCard(
          eyebrow: 'KAAM KE BAARE MEIN',
          child: Text(d.description!, style: OnboardingTypography.body()),
        ),
      );
    }

    if (requirements != null && requirements.isNotEmpty) {
      out.add(
        _sectionCard(
          eyebrow: 'ZAROORI SKILLS',
          // A real count, never the word "Verified" (R8).
          count: requirements.length,
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final String requirement in requirements)
                // No dot, no check: a job REQUIREMENT is not a skill anybody
                // verified on this worker, so it carries no verified grammar.
                // The SAME read-only chip as 'Kaam ki jaankari' above it: a
                // grey dot, no check. Two chip paints on one screen (dotted
                // facts, undotted skills) read as two components for one
                // concept, which is exactly what the kit is meant to stop.
                KitInfoChip(
                  label: requirement,
                  dot: OnboardingColors.ink500,
                  showCheck: false,
                ),
            ],
          ),
        ),
      );
    }

    if (benefits != null && benefits.isNotEmpty) {
      out.add(
        _sectionCard(
          eyebrow: 'BENEFITS',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              for (int i = 0; i < benefits.length; i++) ...<Widget>[
                if (i > 0) const SizedBox(height: 6),
                KitCheckRow(label: benefits[i]),
              ],
            ],
          ),
        ),
      );
    }
    return out;
  }

  Widget _sectionCard({
    required String eyebrow,
    required Widget child,
    int? count,
  }) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(child: KitMicroLabel(eyebrow)),
              if (count != null) KitCountPill(count: count),
            ],
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  /// WA-2: an ALREADY-APPLIED job (opened from an Applied-jobs row, which
  /// threads the real `action` in) shows its status — never an apply action.
  /// A repeat apply is pointless (idempotent upsert) and reads like the first
  /// one never registered.
  Widget _bottomBar(BuildContext context, JobDetailState state) {
    if (state.detail.alreadyApplied) return _appliedStatus();
    return QuestionnaireBottomBar(
      // Same 600 column as the header and the body above it.
      maxWidth: OnboardingLayout.maxTabContentWidth,
      nextLabel: 'Apply karein',
      isLoading: state.applying,
      onNext: state.applying
          ? null
          : () => context.read<JobDetailCubit>().apply(),
      // #375 — icon-only close: without a label TalkBack announces nothing
      // actionable and the only way back out of the detail is unidentifiable.
      leading: KitSquareIconButton(
        icon: Icons.close_rounded,
        semanticLabel: kCloseSemanticLabel,
        iconColor: OnboardingColors.ink600,
        onTap: state.applying ? null : () => context.pop(),
      ),
    );
  }

  /// The applied-state bar. GATED on the real recorded `action` from the
  /// applications API ([JobDetail.alreadyApplied]), but the wire enum itself
  /// never renders — the copy is the DS's warm Hinglish (L-2, low-literacy
  /// audience). Back navigation stays on the header; nothing is left to decide,
  /// so there is no button here at all.
  Widget _appliedStatus() {
    return KitDockedBar(
      maxWidth: OnboardingLayout.maxTabContentWidth,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: OnboardingColors.successBg,
          borderRadius: BorderRadius.circular(OnboardingRadii.docked),
          border: Border.all(color: OnboardingColors.successBorder),
        ),
        child: Row(
          children: <Widget>[
            const Icon(
              Icons.check_circle_rounded,
              size: 24,
              color: OnboardingColors.successGreen,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'Aapne apply kar diya ✓',
                style: OnboardingTypography.anek(
                  size: 16,
                  weight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 12dp between blocks, applied in one place so no card owns the gap after it.
  List<Widget> _spaced(List<Widget> blocks) => <Widget>[
    for (int i = 0; i < blocks.length; i++) ...<Widget>[
      if (i > 0) const SizedBox(height: 12),
      blocks[i],
    ],
  ];
}
