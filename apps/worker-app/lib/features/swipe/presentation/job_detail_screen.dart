import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../domain/job_detail.dart';
import '../domain/swipe_repository.dart';
import 'cubit/job_detail_cubit.dart';

/// Full job posting. Reached full-screen from a Feed card (or an Applied row),
/// which hands over the REAL [JobDetail] it already holds; applying goes through
/// the same path as the Feed.
///
/// Shows ONLY what the worker-facing feed actually returns — title and place. It
/// used to also show an employer name, a "verified" badge, a pay band, a shift,
/// duties, requirements and benefits, ALL invented client-side from
/// `jobId.hashCode`. Nothing here is synthesised: where the backend has no data,
/// the screen shows nothing.
class JobDetailScreen extends StatelessWidget {
  const JobDetailScreen({super.key, required this.detail});

  final JobDetail detail;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<JobDetailCubit>(
      create: (_) => JobDetailCubit(locator<SwipeRepository>(), detail),
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
            children: <Widget>[_headBand(state.detail)],
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
          // Rendered ONLY when the feed actually gave us a place.
          if (place != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s4),
            _fact(Icons.place_outlined, place),
          ],
        ],
      ),
    );
  }

  Widget _fact(IconData icon, String text) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 17, color: AppColors.textFaint),
        const SizedBox(width: AppSpacing.s1),
        Text(text, style: AppTypography.body(color: AppColors.textSecondary)),
      ],
    );
  }

  Widget _stickyCta(BuildContext context, JobDetailState state) {
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
      child: Row(
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
      ),
    );
  }
}
