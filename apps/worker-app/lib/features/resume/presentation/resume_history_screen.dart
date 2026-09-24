import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/api/api_models.dart' show ResumeHistoryItem;
import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import 'cubit/resume_cubit.dart';
import 'resume_preview_screen.dart';
import 'widgets/resume_action_row.dart';
import 'widgets/resume_history_section.dart';

/// The screen's chrome.
const String kResumeHistoryScreenTitle = 'Mere resume';
const String kResumeHistoryScreenSubtitle =
    'Aapke banaye hue saare resume, naye se purane tak.';

/// What a worker with nothing to list sees. NOT an error — a worker who has
/// made exactly one resume is in a perfectly ordinary state, and so is one on a
/// server built before the history route existed.
const String kResumeHistoryEmptyTitle = 'Abhi koi purana resume nahi.';
const String kResumeHistoryEmptyBody =
    'Jab aap naya resume banayenge, purane yahin dikhte rahenge.';

/// Every résumé this worker has made, on its own screen, reached from the
/// Profile tab (#1687).
///
/// WHY A SEPARATE SCREEN when the Résumé tab already shows the same list: that
/// one is a section UNDER the current résumé — it answers "what else do I
/// have?" while the worker is looking at the live one. This answers "show me
/// everything I have made", which is a Profile-tab question, and it is where a
/// worker goes looking for an older résumé rather than for today's.
///
/// It reuses [ResumeHistorySection] rather than drawing its own cards, so the
/// two surfaces cannot drift apart on what a badge, a date or a status means.
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

class _ResumeHistoryView extends StatelessWidget {
  const _ResumeHistoryView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: kResumeHistoryScreenTitle,
            subtitle: kResumeHistoryScreenSubtitle,
            onBack: () => Navigator.maybePop(context),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: BlocBuilder<ResumeCubit, ResumeState>(
                buildWhen: (ResumeState a, ResumeState b) =>
                    a.history != b.history,
                builder: (BuildContext context, ResumeState state) {
                  final List<ResumeHistoryItem> items = state.history.items;
                  if (items.isEmpty) {
                    // Deliberately the EMPTY view, never an error view: the
                    // repository answers `empty` for an older server and for a
                    // failed read alike, and neither is something the worker
                    // did wrong or can act on.
                    return const BbStatusView(
                      icon: Icons.description_outlined,
                      title: kResumeHistoryEmptyTitle,
                      subtitle: kResumeHistoryEmptyBody,
                    );
                  }
                  final double width = MediaQuery.sizeOf(context).width;
                  return ListView(
                    padding: EdgeInsets.fromLTRB(
                      KitInsets.list(width).left,
                      14,
                      KitInsets.list(width).right,
                      28,
                    ),
                    children: <Widget>[
                      ResumeHistorySection(
                        history: state.history,
                        showHeading: false,
                        actionsBuilder: (ResumeHistoryItem item) =>
                            ResumeActionRow(
                              share: ResumeShareButton(resumeId: item.resumeId),
                              download: ResumeDownloadButton(
                                resumeId: item.resumeId,
                              ),
                            ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}
