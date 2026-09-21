import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/pdf_downloader.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_header_actions.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../domain/interview_kit.dart';
import 'cubit/kit_detail_cubit.dart';
import '../../../core/widgets/feedback_fab.dart';

/// Interview-kit detail — one trade's PREP PACK, pushed full-screen from the
/// list: an overview, the four question lists, the checklists, and a download.
///
/// There are NO model answers on the wire, so nothing here pretends to be one.
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
        final InterviewKit? kit = state.kit;
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              ShiftBlueHeader(
                // The trade's real name once it is known; the neutral section
                // name until then — never a guessed trade.
                title: state.status == KitDetailStatus.ready && kit != null
                    ? kit.title
                    : 'Interview kit',
                compact: true,
                // Matches this screen's 600 body column.
                maxWidth: OnboardingLayout.maxTabContentWidth,
                onBack: () => Navigator.of(context).maybePop(),
                actions: <Widget>[
                  if (state.status == KitDetailStatus.ready)
                    _KitDownloadButton(tradeKey: tradeKey),
                ],
              ),
              Expanded(
                child: switch (state.status) {
                  KitDetailStatus.loading => const BbStatusView.loading(),
                  KitDetailStatus.failed => BbStatusView(
                    icon: failureReason(state.failure).icon,
                    title: 'Kit load nahi hui.',
                    subtitle: failureReason(state.failure).reason,
                    action: FilledButton(
                      onPressed: () =>
                          context.read<KitDetailCubit>().load(tradeKey),
                      child: const Text('Try again'),
                    ),
                  ),
                  KitDetailStatus.ready => _detail(context, state.kit!),
                },
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _detail(BuildContext context, InterviewKit kit) {
    final EdgeInsets side = KitInsets.list(
      MediaQuery.sizeOf(context).width,
      max: OnboardingLayout.maxTabContentWidth,
      gutter: 16,
    );
    return ListView(
      padding: EdgeInsets.fromLTRB(
        side.left,
        16,
        side.right,
        // Plus the floating Feedback pill's band, so it floats over empty
        // canvas rather than the last row. See [FeedbackFabInset].
        24 + FeedbackFabInset.of(context),
      ),
      children: <Widget>[
        if (kit.overview.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: KitCard(child: Text(kit.overview, style: _itemStyle)),
          ),
        // The four question LISTS (no model answers on the wire — a prep pack).
        _questionSection('Aam sawaal', kit.commonQuestions),
        _questionSection('Practical sawaal', kit.practicalQuestions),
        _questionSection('Safety sawaal', kit.safetyQuestions),
        _questionSection(
          'Drawing aur measurement',
          kit.drawingMeasurementQuestions,
        ),
        _listSection(
          'Skill checklist',
          kit.skillChecklist,
          Icons.check_circle_outline,
        ),
        _listSection(
          'Interview se pehle dohraayein',
          kit.reviseBefore,
          Icons.menu_book_outlined,
        ),
        _listSection(
          'Documents saath le jaayein',
          kit.documentsToCarry,
          Icons.description_outlined,
        ),
        _listSection('Aam galtiyan', kit.commonMistakes, Icons.error_outline),
        if (kit.hinglishNote.isNotEmpty) _note(kit.hinglishNote),
      ],
    );
  }

  /// A kit item's line — Inter 14 on secondary ink (spec §4 body).
  TextStyle get _itemStyle => OnboardingTypography.inter(
    size: 14,
    height: 1.45,
    color: OnboardingColors.ink600,
  );

  Widget _sectionTitle(String title) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(
      title,
      style: OnboardingTypography.anek(size: 16, weight: FontWeight.w800),
    ),
  );

  /// A numbered list of interview questions for a category (omitted if empty).
  /// The number is mono, so a two-digit question does not shift the text beside
  /// it (spec §1.2: counters are Roboto Mono).
  Widget _questionSection(String title, List<String> items) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: KitCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _sectionTitle(title),
            for (int i = 0; i < items.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      '${i + 1}.',
                      style: OnboardingTypography.monoBold(
                        color: OnboardingColors.shiftBlue,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(child: Text(items[i], style: _itemStyle)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// An icon-bulleted list (checklist / documents / mistakes; omitted if empty).
  Widget _listSection(String title, List<String> items, IconData icon) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: KitCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _sectionTitle(title),
            for (final String item in items)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    // Neutral, not green: these lists include "Aam galtiyan"
                    // (common mistakes) — green is reserved for success / money
                    // / WhatsApp, so a mistakes bullet in green is off-law.
                    // Secondary ink is category-safe.
                    Icon(icon, size: 18, color: OnboardingColors.ink600),
                    const SizedBox(width: 8),
                    Expanded(child: Text(item, style: _itemStyle)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _note(String text) => Container(
    margin: const EdgeInsets.only(top: 8, bottom: 16),
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: OnboardingColors.successBg,
      borderRadius: BorderRadius.circular(OnboardingRadii.card),
      border: Border.all(color: OnboardingColors.successGreen),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        const Icon(
          Icons.lightbulb_outline,
          size: 20,
          color: OnboardingColors.successGreen,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: OnboardingTypography.inter(size: 14, height: 1.45),
          ),
        ),
      ],
    ),
  );
}

/// Header "Download PDF" action for the kit (GET /interview-kit/:tradeKey/download
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
      // Same 48dp footprint as the button it replaces, so the header row does
      // not jump while the download runs.
      return const SizedBox(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              color: OnboardingColors.textOnBlue,
            ),
          ),
        ),
      );
    }
    return KitHeaderIconAction(
      icon: Icons.download,
      tooltip: 'Download PDF',
      onPressed: _download,
    );
  }
}
