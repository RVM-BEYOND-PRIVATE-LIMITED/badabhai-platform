import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import '../domain/interview_kit.dart';
import 'cubit/kit_list_cubit.dart';
import 'widgets/interview_kit_widgets.dart';

/// Interview-kit list — the per-trade prep packs, drawn from
/// `assets/fonts/image/interview_kit.png` (Profile → Interview kit).
///
/// It keeps the shell's bottom bar (no own `bottomNavigationBar`) because it
/// sits inside the PROFILE tab (WA-3: it is entered from Profile, so back must
/// land on Profile).
///
/// The search filters the loaded list locally; no server search route exists.
class KitScreen extends StatelessWidget {
  const KitScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<KitListCubit>(
      create: (_) => locator<KitListCubit>()..load(),
      child: const _KitView(),
    );
  }
}

class _KitView extends StatefulWidget {
  const _KitView();

  @override
  State<_KitView> createState() => _KitViewState();
}

class _KitViewState extends State<_KitView> {
  final TextEditingController _search = TextEditingController();

  /// The local search text (the field's own value, trimmed at use).
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  /// The filtered list: title or trade key contains the query. A new trade the
  /// catalogue adds later is searchable the day it ships — no client table.
  List<KitListItem> _filtered(List<KitListItem> items) {
    final String query = _query.trim().toLowerCase();
    if (query.isEmpty) return items;
    return items
        .where(
          (KitListItem kit) =>
              kit.title.toLowerCase().contains(query) ||
              kit.tradeKey.toLowerCase().replaceAll('_', ' ').contains(query),
        )
        .toList(growable: false);
  }

  void _onSearchChanged(String value) {
    setState(() => _query = value);
  }

  void _clearSearch() {
    _search.clear();
    setState(() => _query = '');
  }

  void _openKit(String tradeKey) {
    context.pushOnce('${Routes.kitDetail}/$tradeKey');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: BlocBuilder<KitListCubit, KitListState>(
        builder: (BuildContext context, KitListState state) {
          final bool ready = state.status == KitListStatus.ready;
          return Column(
            children: <Widget>[
              // One header for every state — the chrome stays put through
              // loading and failure instead of being rebuilt per branch. The
              // search row joins it only once there is a list to filter.
              InterviewKitHeader(
                onBack: () => Navigator.of(context).maybePop(),
                search: ready
                    ? InterviewKitSearchField(
                        controller: _search,
                        onChanged: _onSearchChanged,
                        onClear: _clearSearch,
                      )
                    : null,
              ),
              Expanded(
                child: switch (state.status) {
                  KitListStatus.loading => const BbStatusView.loading(),
                  KitListStatus.failed => BbStatusView(
                    icon: failureReason(state.failure).icon,
                    title: 'Kit load nahi hui.',
                    subtitle: failureReason(state.failure).reason,
                    action: FilledButton(
                      onPressed: () => context.read<KitListCubit>().load(),
                      child: const Text('Try again'),
                    ),
                  ),
                  KitListStatus.ready => InterviewKitListView(
                    items: _filtered(state.items),
                    filtering: _query.trim().isNotEmpty,
                    onOpenKit: _openKit,
                    onClearSearch: _clearSearch,
                  ),
                },
              ),
            ],
          );
        },
      ),
    );
  }
}
