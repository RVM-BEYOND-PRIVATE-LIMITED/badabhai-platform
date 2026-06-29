import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_list_row.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import 'cubit/applications_cubit.dart';

/// "Applied jobs" (Profile → Applied jobs). Mock-backed until GET /me/applications
/// ships; lists the worker's APPLY decisions newest-first. Deliberately no
/// filters, no status timeline, no real job-detail — the backend doesn't back
/// them.
class AppliedJobsScreen extends StatelessWidget {
  const AppliedJobsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ApplicationsCubit>(
      create: (_) => locator<ApplicationsCubit>()..load(),
      child: const _AppliedJobsView(),
    );
  }
}

class _AppliedJobsView extends StatelessWidget {
  const _AppliedJobsView();

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      padded: false,
      appBar: const BbAppBar(title: 'Applied jobs'),
      body: BlocBuilder<ApplicationsCubit, ApplicationsState>(
        builder: (BuildContext context, ApplicationsState state) {
          return switch (state.status) {
            ApplicationsStatus.loading => const BbStatusView.loading(),
            ApplicationsStatus.error => BbStatusView(
                icon: Icons.cloud_off_rounded,
                title: 'Could not load your applied jobs.',
                subtitle: 'Please check your internet and try again.',
                action: FilledButton(
                  onPressed: () => context.read<ApplicationsCubit>().load(),
                  child: const Text('Try again'),
                ),
              ),
            ApplicationsStatus.empty => BbStatusView(
                icon: Icons.work_history_outlined,
                title: 'Abhi tak koi job apply nahi ki',
                action: FilledButton(
                  onPressed: () => context.go(Routes.jobs),
                  child: const Text('Jobs dekhein'),
                ),
              ),
            ApplicationsStatus.ready => _list(context, state.jobs),
          };
        },
      ),
    );
  }

  Widget _list(BuildContext context, List<AppliedJob> jobs) {
    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s2),
      itemCount: jobs.length,
      itemBuilder: (BuildContext context, int index) {
        final AppliedJob job = jobs[index];
        // Subtitle: "trade · city", with the area prepended when present.
        final String place = (job.area != null && job.area!.isNotEmpty)
            ? '${job.area}, ${job.city}'
            : job.city;
        return Material(
          type: MaterialType.transparency,
          child: InkWell(
            // Row tap → job details (MOCK, the existing job-detail route).
            // TODO(backend): swap to the real worker job-detail endpoint when it
            // lands — detail is mock for now.
            onTap: () => context.push('${Routes.jobDetail}/${job.jobId}'),
            child: BbListRow.notification(
              icon: Icons.work_history,
              tone: BbNotiTone.green,
              title: job.title,
              subtitle: '${job.tradeKey} · $place',
              time: appliedRelativeLabel(job.createdAt),
            ),
          ),
        );
      },
    );
  }
}

/// "Applied · 2 din pehle" — a coarse Hinglish relative-time label off
/// [createdAt]. [now] is injectable for deterministic tests.
String appliedRelativeLabel(DateTime createdAt, {DateTime? now}) {
  final Duration d = (now ?? DateTime.now()).difference(createdAt);
  final String rel;
  if (d.inMinutes < 1) {
    rel = 'abhi';
  } else if (d.inMinutes < 60) {
    rel = '${d.inMinutes} minute pehle';
  } else if (d.inHours < 24) {
    rel = '${d.inHours} ghante pehle';
  } else {
    rel = '${d.inDays} din pehle';
  }
  return 'Applied · $rel';
}
