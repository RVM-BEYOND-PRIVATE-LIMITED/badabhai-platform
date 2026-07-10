import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_tag.dart';
import 'cubit/job_detail_cubit.dart';
import '../domain/job_detail.dart';

/// Full job posting (spec §5.6). Reached full-screen from the Feed card title;
/// applies through the same path as the Feed, then routes to Applied.
class JobDetailScreen extends StatelessWidget {
  const JobDetailScreen({super.key, required this.jobId});

  final String jobId;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<JobDetailCubit>(
      create: (_) => locator<JobDetailCubit>()..load(jobId),
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
      appBar: BbAppBar(
        title: '',
        actions: <Widget>[
          IconButton(
            tooltip: 'Share',
            icon: const Icon(Icons.share),
            onPressed: () => ScaffoldMessenger.of(context)
              ..clearSnackBars()
              ..showSnackBar(
                const SnackBar(content: Text('Share coming soon')),
              ),
          ),
        ],
      ),
      body: BlocConsumer<JobDetailCubit, JobDetailState>(
        listenWhen: (JobDetailState p, JobDetailState c) =>
            p.appliedNonce != c.appliedNonce ||
            p.applyErrorNonce != c.applyErrorNonce,
        listener: (BuildContext context, JobDetailState state) {
          if (state.appliedNonce != _shownApplied) {
            _shownApplied = state.appliedNonce;
            // J3: the "Apply ho gaya" screen is gone — pop back to the Jobs
            // feed with a result so it surfaces an "Applied" toast.
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
        builder: (BuildContext context, JobDetailState state) {
          return switch (state.status) {
            JobDetailStatus.loading => const BbStatusView.loading(),
            JobDetailStatus.failed => BbStatusView(
                icon: failureReason(state.failure).icon,
                title: 'Job load nahi hui.',
                subtitle: failureReason(state.failure).reason,
                action: FilledButton(
                  onPressed: () => context
                      .read<JobDetailCubit>()
                      .load(state.detail?.jobId ?? ''),
                  child: const Text('Try again'),
                ),
              ),
            JobDetailStatus.ready => _detail(context, state.detail!, state),
          };
        },
      ),
    );
  }

  Widget _detail(BuildContext context, JobDetail d, JobDetailState state) {
    return Column(
      children: <Widget>[
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: <Widget>[
              _headBand(d),
              _block(
                'Kaam kya hai',
                child: _bullets(d.duties),
              ),
              _block(
                'Chahiye',
                child: Wrap(
                  spacing: AppSpacing.s2,
                  runSpacing: AppSpacing.s2,
                  children:
                      d.requirements.map((String r) => BbTag(r)).toList(),
                ),
              ),
              _block(
                'Faayde',
                last: true,
                child: _bullets(d.benefits),
              ),
            ],
          ),
        ),
        _stickyCta(context, state),
      ],
    );
  }

  Widget _headBand(JobDetail d) {
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
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(d.title,
                        style: AppTypography.display(
                            size: AppTypography.size2xl,
                            weight: FontWeight.w800)),
                    const SizedBox(height: AppSpacing.s1),
                    Row(
                      children: <Widget>[
                        Flexible(
                          child: Text(d.company,
                              style: AppTypography.body(
                                  color: AppColors.textSecondary,
                                  weight: FontWeight.w600)),
                        ),
                        if (d.verified) ...<Widget>[
                          const SizedBox(width: AppSpacing.s1),
                          const Icon(Icons.verified,
                              size: 16, color: AppColors.success),
                        ],
                      ],
                    ),
                  ],
                ),
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
          const SizedBox(height: AppSpacing.s4),
          Wrap(
            spacing: AppSpacing.s5,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              _fact(Icons.place_outlined, d.location),
              _fact(Icons.schedule, d.shift),
              _fact(Icons.currency_rupee, d.payBand, mono: true),
            ],
          ),
        ],
      ),
    );
  }

  Widget _fact(IconData icon, String text, {bool mono = false}) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 17, color: AppColors.textFaint),
        const SizedBox(width: AppSpacing.s1),
        Text(
          text,
          style: mono
              ? AppTypography.mono(
                  weight: FontWeight.w700, color: AppColors.textPrimary)
              : AppTypography.body(color: AppColors.textSecondary),
        ),
      ],
    );
  }

  Widget _block(String heading, {required Widget child, bool last = false}) {
    return Container(
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: AppColors.divider)),
      ),
      padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.gutter, vertical: AppSpacing.s4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(heading.toUpperCase(), style: AppTypography.eyebrow()),
          const SizedBox(height: AppSpacing.s3),
          child,
        ],
      ),
    );
  }

  Widget _bullets(List<String> items) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (final String item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.s2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const Padding(
                  padding: EdgeInsets.only(top: 2),
                  child: Icon(Icons.check_circle,
                      size: 18, color: AppColors.success),
                ),
                const SizedBox(width: AppSpacing.s2),
                Expanded(
                  child: Text(item,
                      style: AppTypography.body(
                          color: AppColors.textSecondary)),
                ),
              ],
            ),
          ),
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
                child:
                    Icon(Icons.close, color: AppColors.textMuted, size: 26),
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
