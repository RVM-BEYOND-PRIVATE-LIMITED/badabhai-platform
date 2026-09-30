import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../domain/general_sheet_sections.dart';
import 'resume_document_view.dart';
import 'resume_general_sheet_rows.dart';

/// #1736 — THE GENERAL SHEET, ON THE WORKER'S OWN TAB.
///
/// Every worker outside the 21 predefined roles prints `bb_general` (#1735):
/// grey section bars, `Label: value` rows, Languages under Availability &
/// Terms, certifications as bullets. The tab kept drawing the trade sheet's v3
/// cards for them, so their Download, Share and employer copy said one thing
/// and their own screen said another — and the screen is the only place the
/// worker can check whether what an employer reads about him is true.
///
/// SAME DATA, NEW LAYOUT — nothing here is fetched, inferred or composed. The
/// split is [mapGeneralSheet]'s; this file is the drawing.
///
/// THE 21 FORM ROLES ARE UNTOUCHED: they keep [ResumeDocumentView], and this
/// widget is never reached for them (see `isGeneralSheetDocument` and the switch
/// in `resume_preview_screen.dart`).
///
/// TWO ELEMENTS THE SHEET DELIBERATELY DROPS, for the reasons its own template
/// header gives: the verdict SUBHEAD (city, availability and pay — all printed
/// here as Availability & Terms rows) and the "own words" QUOTES block (the
/// same sentences the work history already prints). The worker's ability to
/// REFUSE a rewrite is not dropped with them — it rides each work-history entry
/// exactly as it does on the trade sheet (#1354), which is the one affordance
/// that must survive a change of layout.
class ResumeGeneralSheetView extends StatelessWidget {
  const ResumeGeneralSheetView({super.key, required this.document});

  final TradeSheetResumeDocument document;

  @override
  Widget build(BuildContext context) {
    final GeneralSheetSections sections = mapGeneralSheet(document);
    final bool hasWork =
        document.employments.isNotEmpty || document.experiences.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // EVERY SECTION IS CONDITIONAL. An empty one draws nothing at all —
        // not a bare grey bar (#1736 acceptance), the same rule the printed
        // sheet gets from its `:empty` selectors.
        if (sections.skills.isNotEmpty)
          _GeneralSection(
            title: kGeneralSheetSkillsTitle,
            children: <Widget>[
              for (final GeneralSheetRow row in sections.skills)
                ResumeSheetLabelValue(label: row.label, value: row.value),
            ],
          ),
        if (sections.availability.isNotEmpty)
          _GeneralSection(
            title: kGeneralSheetAvailabilityTitle,
            children: <Widget>[
              for (final GeneralSheetRow row in sections.availability)
                ResumeSheetLabelValue(label: row.label, value: row.value),
            ],
          ),
        if (hasWork)
          _GeneralSection(
            title: kGeneralSheetWorkTitle,
            children: <Widget>[
              for (final ResumeEmploymentDto employment in document.employments)
                ResumeEmploymentEntry(
                  employment: employment,
                  style: ResumeEmploymentStyle.generalSheet,
                ),
              // The shared entry, in this sheet's style — so the fresher keeps
              // #1492's reveal and refusal instead of a look-alike without them.
              for (final ResumeExperienceLineDto experience
                  in document.experiences)
                ResumeTrainingEntry(
                  line: experience,
                  style: ResumeEmploymentStyle.generalSheet,
                ),
              if (document.employmentsMore != null &&
                  document.employmentsMore!.trim().isNotEmpty)
                Text(
                  document.employmentsMore!,
                  style: OnboardingTypography.inter(
                    size: 12,
                    height: 1.4,
                    color: OnboardingColors.ink500,
                  ),
                ),
            ],
          ),
        if (sections.education.isNotEmpty)
          _GeneralSection(
            title: kGeneralSheetEducationTitle,
            children: <Widget>[
              // The section heading IS the label, so the degree line prints
              // bold and unlabelled — as on the sheet (`.sec-edu .lab
              // { display: none }`).
              for (final String line in sections.education)
                Text(
                  line,
                  style: OnboardingTypography.inter(
                    size: 13,
                    weight: FontWeight.w700,
                    height: 1.4,
                    color: OnboardingColors.ink900,
                  ),
                ),
            ],
          ),
        if (sections.certifications.isNotEmpty)
          _GeneralSection(
            title: kGeneralSheetCertificationsTitle,
            children: <Widget>[
              for (final GeneralSheetCertLine line in sections.certifications)
                line.label == null
                    ? ResumeSheetBullet(text: line.value)
                    : ResumeSheetLabelValue(label: line.label!, value: line.value),
            ],
          ),
      ],
    );
  }
}

/// The section bar titles, in Title Case, exactly as the printed sheet's bars
/// read (`bb_general.v1.html`'s `content:` rules). They are the sheet's own
/// words and are asserted against it in the tab tests.
const String kGeneralSheetSkillsTitle = 'Skills';
const String kGeneralSheetAvailabilityTitle = 'Availability & Terms';
const String kGeneralSheetWorkTitle = 'Work History';
const String kGeneralSheetEducationTitle = 'Education';
const String kGeneralSheetCertificationsTitle = 'Certifications & Training';

/// One section: the grey bar, then its rows.
///
/// A BAR, NOT A CARD. The trade sheet's zones are white v3 cards; this sheet's
/// are flush grey bars over plain rows, and mixing the two would read as two
/// resumes on one screen.
class _GeneralSection extends StatelessWidget {
  const _GeneralSection({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          margin: const EdgeInsets.only(bottom: 10),
          // The sheet's bar is #e5e5e5; `borderCard` is the v3 token at that
          // value, so the bar is a token, never a new grey.
          color: OnboardingColors.borderCard,
          child: Text(
            title,
            style: OnboardingTypography.inter(
              size: 13,
              weight: FontWeight.w700,
              color: OnboardingColors.ink900,
            ),
          ),
        ),
        for (int i = 0; i < children.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(height: 6),
          children[i],
        ],
        const SizedBox(height: kResumeCardGap),
      ],
    );
  }
}



