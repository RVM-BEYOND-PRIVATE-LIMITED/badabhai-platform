import 'package:flutter/material.dart';

/// Leading icons for the finishing form's option cards (the Workholding /
/// Measuring / Operations mockups draw an icon tile on every card).
///
/// DISPLAY ONLY. These never change which options exist, what they are called,
/// or what is sent — the labels and slugs stay server data (or the #1298
/// pinned education vocabularies).
///
/// The documents / shift / job-type rules are NOT here: the trade form's
/// preferences marker shows the same server lists, so both walks share
/// `documentOptionIcon` / `shiftOptionIcon` / `jobTypeOptionIcon` from
/// `core/widgets/onboarding/option_icons.dart` and an option draws the same
/// glyph in either walk. What is left is each page's own single icon.

/// Every language card.
const IconData kFinishingLanguageIcon = Icons.translate_rounded;

/// Every salary band card.
const IconData kFinishingSalaryIcon = Icons.currency_rupee_rounded;

/// Every education (credential / council) card.
const IconData kFinishingEducationIcon = Icons.school_outlined;
