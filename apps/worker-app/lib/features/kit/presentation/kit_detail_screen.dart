import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pdf_downloader.dart';
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
          if (kit.overview.isNotEmpty) ...<Widget>[
            Text(
              kit.overview,
              style: AppTypography.body(color: AppColors.textSecondary),
            ),
            const SizedBox(height: AppSpacing.s5),
          ],
          // The four question LISTS (no model answers on the wire — a prep pack).
          _questionSection('Aam sawaal', kit.commonQuestions),
          _questionSection('Practical sawaal', kit.practicalQuestions),
          _questionSection('Safety sawaal', kit.safetyQuestions),
          _questionSection(
              'Drawing aur measurement', kit.drawingMeasurementQuestions),
          _listSection('Skill checklist', kit.skillChecklist,
              Icons.check_circle_outline),
          _listSection('Interview se pehle dohraayein', kit.reviseBefore,
              Icons.menu_book_outlined),
          _listSection('Documents saath le jaayein', kit.documentsToCarry,
              Icons.description_outlined),
          _listSection(
              'Aam galtiyan', kit.commonMistakes, Icons.error_outline),
          if (kit.hinglishNote.isNotEmpty) _note(kit.hinglishNote),
        ],
      ),
    );
  }

  Widget _sectionTitle(String title) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.s3),
        child: Text(
          title,
          style: AppTypography.display(
              size: AppTypography.sizeBase, weight: FontWeight.w800),
        ),
      );

  /// A numbered list of interview questions for a category (omitted if empty).
  Widget _questionSection(String title, List<String> items) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(title),
          for (int i = 0; i < items.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.s2),
              child: Text(
                '${i + 1}. ${items[i]}',
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
            ),
        ],
      ),
    );
  }

  /// An icon-bulleted list (checklist / documents / mistakes; omitted if empty).
  Widget _listSection(String title, List<String> items, IconData icon) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _sectionTitle(title),
          for (final String item in items)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.s2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(icon, size: 18, color: AppColors.success),
                  const SizedBox(width: AppSpacing.s2),
                  Expanded(
                    child: Text(
                      item,
                      style:
                          AppTypography.body(color: AppColors.textSecondary),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _note(String text) => Container(
        margin: const EdgeInsets.only(top: AppSpacing.s2, bottom: AppSpacing.s4),
        padding: const EdgeInsets.all(AppSpacing.s4),
        decoration: BoxDecoration(
          color: AppColors.successTint,
          borderRadius: BorderRadius.circular(AppRadii.lg),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Icon(Icons.lightbulb_outline,
                size: 20, color: AppColors.success),
            const SizedBox(width: AppSpacing.s2),
            Expanded(child: Text(text, style: AppTypography.body())),
          ],
        ),
      );
}

/// AppBar "Download PDF" action for the kit (GET /interview-kit/:tradeKey/download
/// — real, public). Resolves a short-lived signed url via the cubit and downloads
/// the PDF IN-APP into the device's Downloads — the worker stays on this screen
/// (started/complete SnackBars, "Kholein" opens the saved file). The spinner
/// replaces the button for the WHOLE download, so a double-tap can't produce
/// double files. The url is fetched in memory, never logged.
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
    await downloadSignedPdf(
      context,
      resolve: () => cubit.resolveDownloadUrl(widget.tradeKey),
      fileName: 'BadaBhai-Interview-Kit-${widget.tradeKey}.pdf',
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
