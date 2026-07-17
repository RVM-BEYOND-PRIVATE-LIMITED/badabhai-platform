import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/job_display.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_tag.dart';
import '../domain/job_detail.dart';
import '../domain/jobs_repository.dart';
import '../domain/swipe_repository.dart';
import 'cubit/job_detail_cubit.dart';

/// Full job posting. Reached full-screen from a Feed card (or an Applied row),
/// which hands over the light [JobDetail] it already holds — the header (title
/// + place) renders instantly from it while the FULL worker-visible posting is
/// fetched from `GET /jobs/:jobId` (the ADR-0024 addendum, 2026-07-16).
/// Applying goes through the same path as the Feed.
///
/// Shows ONLY what the backend actually returns: pay band, shift, experience
/// window, needed-by, description, requirements and benefits — each row
/// rendered ONLY when its field is non-null (a null field HIDES its row, never
/// a placeholder). EMPLOYER IDENTITY IS HIDDEN ENTIRELY per the addendum
/// ruling: no company name, no masked descriptor, no verified badge, no
/// spots-left — nothing employer-shaped. An earlier build invented all of that
/// client-side from `jobId.hashCode`; nothing here is synthesised.
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
      appBar: const BbAppBar(title: ''),
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
                    content: Text('Could not apply. Please try again.')),
              );
          }
        },
        builder: (BuildContext context, JobDetailState state) =>
            _detail(context, state),
      ),
    );
  }

  Widget _detail(BuildContext context, JobDetailState state) {
    return Column(
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: <Widget>[
              _headBand(state.detail),
              if (state.loading)
                _loading()
              else ...<Widget>[
                if (state.loadFailed) _loadFailedNote(context),
                ..._sections(state.detail),
              ],
            ],
          ),
        ),
        _stickyCta(context, state),
      ],
    );
  }

  Widget _headBand(JobDetail d) {
    final String? place = d.place;
    return Container(
      width: double.infinity,
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[AppColors.vermilion50, AppColors.surfacePage],
        ),
      ),
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s4, AppSpacing.gutter, AppSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Text(d.title,
                    style: AppTypography.display(
                        size: AppTypography.size2xl, weight: FontWeight.w800)),
              ),
              const SizedBox(width: AppSpacing.s3),
              Container(
                width: 50,
                height: 50,
                decoration: BoxDecoration(
                  color: AppColors.saffron100,
                  borderRadius: BorderRadius.circular(AppRadii.md),
                ),
                child: const Icon(Icons.build_outlined,
                    color: AppColors.saffron700, size: 24),
              ),
            ],
          ),
          // Rendered ONLY when the source actually gave us a place.
          if (place != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s4),
            _fact(Icons.place_outlined, Text(place,
                style: AppTypography.body(color: AppColors.textSecondary))),
          ],
        ],
      ),
    );
  }

  /// Fetch-phase spinner below the instantly-rendered header.
  Widget _loading() {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: AppSpacing.s7),
      child: Center(child: CircularProgressIndicator()),
    );
  }

  /// Quiet retry affordance: the light header above stays — what we have is
  /// real — only the FULL posting failed to load.
  Widget _loadFailedNote(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s4, AppSpacing.gutter, 0),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              'Poori jaankari load nahi hui.',
              style: AppTypography.body(color: AppColors.textSecondary),
            ),
          ),
          TextButton(
            style: TextButton.styleFrom(
              minimumSize: const Size(AppSpacing.tap, AppSpacing.tap),
            ),
            onPressed: () => context.read<JobDetailCubit>().retry(),
            child: const Text('Try again'),
          ),
        ],
      ),
    );
  }

  /// The full-posting sections, each rendered ONLY when its field is non-null
  /// (a null field hides its row — never fabricated). Order per the ADR-0024
  /// addendum build spec: pay, shift, experience, needed-by, description,
  /// requirements, benefits.
  List<Widget> _sections(JobDetail d) {
    final String? pay = formatPayBandFull(d.payMin, d.payMax);
    final String? shift = shiftLabel(d.shift);
    final String? experience =
        experienceLabel(d.minExperienceYears, d.maxExperienceYears);
    final String? neededBy = neededByLabel(d.neededBy);
    final List<String>? requirements = d.requirements;
    final List<String>? benefits = d.benefits;

    return <Widget>[
      if (pay != null ||
          shift != null ||
          experience != null ||
          neededBy != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter, AppSpacing.s4, AppSpacing.gutter, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              if (pay != null) ...<Widget>[
                _fact(
                  Icons.currency_rupee,
                  // Money renders in the data font (Roboto Mono), like the
                  // deck card's pay band.
                  Text(pay,
                      style: AppTypography.mono(
                          weight: FontWeight.w700,
                          color: AppColors.textPrimary)),
                ),
                const SizedBox(height: AppSpacing.s3),
              ],
              if (shift != null) ...<Widget>[
                _fact(Icons.schedule, _factText('$shift shift')),
                const SizedBox(height: AppSpacing.s3),
              ],
              if (experience != null) ...<Widget>[
                _fact(Icons.work_outline, _factText(experience)),
                const SizedBox(height: AppSpacing.s3),
              ],
              if (neededBy != null) ...<Widget>[
                _fact(Icons.event_available_outlined, _factText(neededBy)),
                const SizedBox(height: AppSpacing.s3),
              ],
            ],
          ),
        ),
      if (d.description != null && d.description!.trim().isNotEmpty)
        _section(
          'KAAM KE BAARE MEIN',
          Text(d.description!,
              style: AppTypography.body(color: AppColors.textSecondary)),
        ),
      if (requirements != null && requirements.isNotEmpty)
        _section(
          'REQUIREMENTS',
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: requirements.map(BbTag.new).toList(),
          ),
        ),
      if (benefits != null && benefits.isNotEmpty)
        _section(
          'BENEFITS',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              for (final String benefit in benefits)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.s2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      const Icon(Icons.check_circle_outline,
                          size: 18, color: AppColors.success),
                      const SizedBox(width: AppSpacing.s2),
                      Expanded(
                        child: Text(benefit,
                            style: AppTypography.body(
                                color: AppColors.textSecondary)),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      const SizedBox(height: AppSpacing.s5),
    ];
  }

  /// Eyebrow heading + content block (matches the app's section pattern).
  Widget _section(String heading, Widget child) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s5, AppSpacing.gutter, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(heading, style: AppTypography.eyebrow()),
          const SizedBox(height: AppSpacing.s3),
          child,
        ],
      ),
    );
  }

  Widget _fact(IconData icon, Widget text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Icon(icon, size: 17, color: AppColors.textFaint),
        const SizedBox(width: AppSpacing.s2),
        Expanded(child: text),
      ],
    );
  }

  Text _factText(String value) =>
      Text(value, style: AppTypography.body(color: AppColors.textSecondary));

  Widget _stickyCta(BuildContext context, JobDetailState state) {
    // WA-2: an ALREADY-APPLIED job (opened from an Applied-jobs row, which
    // threads the real `action` in) shows its status — never an apply action.
    // A repeat apply is pointless (idempotent upsert) and reads like the first
    // one never registered.
    final Widget content = state.detail.alreadyApplied
        ? _appliedStatus(state)
        : _applyRow(context, state);
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surfaceCard,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      padding: EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s3,
        AppSpacing.gutter,
        AppSpacing.s3 + MediaQuery.of(context).padding.bottom,
      ),
      child: content,
    );
  }

  /// The applied-state bar. GATED on the real recorded `action` from the
  /// applications API ([JobDetail.alreadyApplied]), but the wire enum itself
  /// never renders — the copy is the DS's warm Hinglish (L-2, low-literacy
  /// audience). Back navigation stays on the app bar; nothing is left to
  /// decide.
  Widget _appliedStatus(JobDetailState state) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s4, vertical: AppSpacing.s3),
      decoration: BoxDecoration(
        color: AppColors.successTint,
        borderRadius: BorderRadius.circular(AppRadii.md),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.check_circle, color: AppColors.success, size: 26),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Text('Aapne apply kar diya ✓',
                style: AppTypography.display(
                    size: AppTypography.sizeBase, weight: FontWeight.w800)),
          ),
        ],
      ),
    );
  }

  Widget _applyRow(BuildContext context, JobDetailState state) {
    return Row(
      children: <Widget>[
        Material(
          color: AppColors.surfaceCard,
          shape: const CircleBorder(
            side: BorderSide(color: AppColors.borderStrong, width: 2),
          ),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: state.applying ? null : () => context.pop(),
            child: const SizedBox(
              width: 56,
              height: 56,
              child: Icon(Icons.close, color: AppColors.textMuted, size: 26),
            ),
          ),
        ),
        const SizedBox(width: AppSpacing.s3),
        Expanded(
          child: BbButton(
            label: 'Apply karein',
            iconLeft: Icons.check,
            loading: state.applying,
            onPressed: state.applying
                ? null
                : () => context.read<JobDetailCubit>().apply(),
          ),
        ),
      ],
    );
  }
}
