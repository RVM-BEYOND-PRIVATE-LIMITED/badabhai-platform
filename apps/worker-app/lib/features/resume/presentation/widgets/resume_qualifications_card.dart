import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart' show QualificationOptionsDto;
import '../../../../core/di/locator.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/kit/kit_card.dart';
import '../../../../core/widgets/kit/kit_micro_label.dart';
import '../../../trade_form/domain/trade_form_models.dart';
import '../../../trade_form/domain/trade_form_repository.dart';
import '../../domain/resume_qualifications.dart';
import 'resume_card_slots.dart';
import 'resume_general_sheet_rows.dart';

/// The card's title — the same header treatment as "Work History".
const String kResumeQualificationsTitle = 'Education & Certificates';

/// The two micro labels inside the card.
const String kResumeEducationLabel = 'EDUCATION';
const String kResumeCertificatesLabel = 'CERTIFICATES';

/// The Resume tab's "Education & Certificates" card (`education.jpeg`).
///
/// Education and certificates used to print as one-line facts inside the
/// "Qualification, documents & languages" card — `Education: 10th pass · State
/// board · 2010 · Govt School · 12th pass · …` — which read as a paragraph. They
/// now get their own titled card, like Work History: one row per entry, the
/// entry's name in bold, its board / institute / issuer under it, its year on
/// the right, each list NEWEST FIRST (see [sortNewestFirst]).
///
/// THE ROWS COME FROM `GET /workers/me/qualifications`, one field each — the
/// same records the sheet's line is rendered from. [fallback] is the sheet's
/// own Education / Certificates lines: shown while that read is in flight, and
/// kept whenever it cannot answer (no form-entered rows — a worker whose
/// education came only from the chat — or a failed read). So the card never
/// shows less than the sheet printed, and never shows nothing.
class ResumeQualificationsCard extends StatefulWidget {
  const ResumeQualificationsCard({super.key, required this.fallback});

  /// The sheet's own Education / Certificates fact rows, verbatim.
  final List<ResumeFact> fallback;

  @override
  State<ResumeQualificationsCard> createState() =>
      _ResumeQualificationsCardState();
}

class _ResumeQualificationsCardState extends State<ResumeQualificationsCard> {
  List<ResumeQualificationItem> _education = const <ResumeQualificationItem>[];
  List<ResumeQualificationItem> _certificates =
      const <ResumeQualificationItem>[];

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// FAIL-SILENT: any failure keeps the sheet's own lines on screen. The
  /// vocabulary read is optional on its own — without it, slugs are humanised.
  Future<void> _load() async {
    if (!locator.isRegistered<TradeFormRepository>()) return;
    final TradeFormRepository repo = locator<TradeFormRepository>();
    try {
      final TradeFormQualifications? saved =
          await repo.loadSavedQualifications();
      if (saved == null) return;
      QualificationOptionsDto? options;
      try {
        options = await repo.loadQualificationOptions();
      } catch (_) {
        options = null;
      }
      if (!mounted) return;
      setState(() {
        _education = resumeEducationItems(saved.educations, options: options);
        _certificates = resumeCertificateItems(saved.certificates);
      });
    } catch (_) {
      // The sheet's own lines stay; this screen never errors on an optional read.
    }
  }

  bool get _structured => _education.isNotEmpty || _certificates.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const KitCardHeader(
            icon: Icons.school_outlined,
            title: kResumeQualificationsTitle,
          ),
          if (_structured) ...<Widget>[
            if (_education.isNotEmpty)
              _Block(label: kResumeEducationLabel, items: _education),
            if (_certificates.isNotEmpty)
              _Block(label: kResumeCertificatesLabel, items: _certificates),
          ] else
            for (final ResumeFact fact in widget.fallback) ...<Widget>[
              const SizedBox(height: 12),
              _FallbackBlock(fact: fact),
            ],
        ],
      ),
    );
  }
}

/// One labelled list: "EDUCATION" over its rows.
class _Block extends StatelessWidget {
  const _Block({required this.label, required this.items});

  final String label;
  final List<ResumeQualificationItem> items;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          KitMicroLabel(label),
          for (int i = 0; i < items.length; i++) ...<Widget>[
            const SizedBox(height: 10),
            _Row(item: items[i]),
            if (i < items.length - 1) ...<Widget>[
              const SizedBox(height: 10),
              const Divider(height: 1, color: OnboardingColors.borderSubtle),
            ],
          ],
        ],
      ),
    );
  }
}

/// The name in bold with its year on the right, the board / institute /
/// issuer under it — the same geometry the Work History rows use.
class _Row extends StatelessWidget {
  const _Row({required this.item});

  final ResumeQualificationItem item;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        ResumeSheetHeadRow(
          title: item.title,
          when: item.year?.toString() ?? '',
        ),
        if (item.detail != null) ...<Widget>[
          const SizedBox(height: 2),
          Text(
            item.detail!,
            style: OnboardingTypography.inter(
              size: 12,
              height: 1.35,
              color: OnboardingColors.ink500,
            ),
          ),
        ],
      ],
    );
  }
}

/// The sheet's own line when there are no rows to draw — under its label, so it
/// still reads as part of this card rather than as a stray fact.
class _FallbackBlock extends StatelessWidget {
  const _FallbackBlock({required this.fact});

  final ResumeFact fact;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        KitMicroLabel(fact.label.toUpperCase()),
        const SizedBox(height: 6),
        Text(
          fact.value,
          style: OnboardingTypography.inter(
            size: 13,
            weight: FontWeight.w600,
            height: 1.4,
          ),
        ),
      ],
    );
  }
}
