import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pdf_launcher.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/kit_detail_cubit.dart';
import '../domain/interview_kit.dart';

/// Interview-kit detail (spec §5.4 / `.aw-q`, screens.jsx 250-267). Full-screen
/// from the list; numbered Q&A cards with a (stub) download action.
class KitDetailScreen extends StatelessWidget {
  const KitDetailScreen({super.key, required this.tradeKey});

  final String tradeKey;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<KitDetailCubit>(
      create: (_) => locator<KitDetailCubit>()..load(tradeKey),
      child: _KitDetailView(tradeKey: tradeKey),
    );
  }
}

class _KitDetailView extends StatelessWidget {
  const _KitDetailView({required this.tradeKey});

  final String tradeKey;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<KitDetailCubit, KitDetailState>(
      builder: (BuildContext context, KitDetailState state) {
        return switch (state.status) {
          KitDetailStatus.loading => const Scaffold(
              appBar: BbAppBar(title: 'Interview kit'),
              body: BbStatusView.loading(),
            ),
          KitDetailStatus.failed => Scaffold(
              appBar: const BbAppBar(title: 'Interview kit'),
              body: BbStatusView(
                icon: failureReason(state.failure).icon,
                title: 'Kit load nahi hui.',
                subtitle: failureReason(state.failure).reason,
                action: FilledButton(
                  onPressed: () => context.read<KitDetailCubit>().load(tradeKey),
                  child: const Text('Try again'),
                ),
              ),
            ),
          KitDetailStatus.ready => _detail(context, state.kit!),
        };
      },
    );
  }

  Widget _detail(BuildContext context, InterviewKit kit) {
    return Scaffold(
      appBar: BbAppBar(
        title: kit.title,
        actions: <Widget>[
          _KitDownloadButton(tradeKey: tradeKey),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.gutter,
          vertical: AppSpacing.s4,
        ),
        children: <Widget>[
          for (int i = 0; i < kit.qas.length; i++)
            _qaCard(i, kit.qas[i], last: i == kit.qas.length - 1),
        ],
      ),
    );
  }

  Widget _qaCard(int index, KitQa qa, {required bool last}) {
    return Container(
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: AppColors.divider)),
      ),
      padding: EdgeInsets.only(
        bottom: last ? AppSpacing.s2 : AppSpacing.s5,
        top: index == 0 ? 0 : AppSpacing.s5,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Q${index + 1}. ${qa.question}',
            style: AppTypography.display(
              size: AppTypography.sizeBase,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            qa.answer,
            style: AppTypography.body(color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }
}

/// AppBar "Download PDF" action for the kit (GET /interview-kit/:tradeKey/download
/// — real, public). Resolves a short-lived signed url via the cubit and opens it
/// in the device viewer; shows a spinner while resolving and a user-safe SnackBar
/// on failure. The url is launched immediately, never logged.
class _KitDownloadButton extends StatefulWidget {
  const _KitDownloadButton({required this.tradeKey});

  final String tradeKey;

  @override
  State<_KitDownloadButton> createState() => _KitDownloadButtonState();
}

class _KitDownloadButtonState extends State<_KitDownloadButton> {
  bool _loading = false;

  Future<void> _download() async {
    final KitDetailCubit cubit = context.read<KitDetailCubit>();
    setState(() => _loading = true);
    await openSignedPdf(
      context,
      resolve: () => cubit.resolveDownloadUrl(widget.tradeKey),
    );
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.all(14),
        child: SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    return IconButton(
      tooltip: 'Download PDF',
      icon: const Icon(Icons.download),
      onPressed: _download,
    );
  }
}
