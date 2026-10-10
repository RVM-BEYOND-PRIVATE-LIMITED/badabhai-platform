import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';

/// ── TWO DISPLAY FACES, ON PURPOSE (owner request) ───────────────────────────
///
/// #1999 moved the app's display family to Kilimanjaro Sans. The FORM FLOW's
/// questions and option cards are deliberately NOT on it — the owner wants Anek
/// Latin there, with Kilimanjaro reserved for the TOP HEADER area.
///
/// So this is a deliberate split, not drift. Anyone "unifying" the two families
/// reddens this file.
void main() {
  const String kNew = 'Kilimanjaro Sans';
  const String kOld = 'Anek Latin';

  group('the form flow uses the OLD display face', () {
    test('a question headline is Anek Latin', () {
      expect(OnboardingTypography.formQuestionHeadline().fontFamily, kOld);
    });

    test('an option card title is Anek Latin', () {
      expect(OnboardingTypography.formCardTitle().fontFamily, kOld);
    });

    test('so is anything else drawn with formDisplay', () {
      expect(OnboardingTypography.formDisplay(size: 16).fontFamily, kOld);
    });

    test('and never Kilimanjaro, not even as a fallback', () {
      // Kilimanjaro is a 182-glyph Latin cut; in this chain it would only ever
      // steal glyphs from the face the owner asked for.
      for (final TextStyle style in <TextStyle>[
        OnboardingTypography.formQuestionHeadline(),
        OnboardingTypography.formCardTitle(),
        OnboardingTypography.formDisplay(size: 16),
      ]) {
        expect(style.fontFamily, isNot(kNew));
        expect(style.fontFamilyFallback ?? const <String>[],
            isNot(contains(kNew)));
      }
    });

    test('Devanagari still has a face to land on', () {
      // Anek Latin carries no Devanagari, so the chain must reach Baloo 2.
      expect(OnboardingTypography.formDisplayFallback, contains('Baloo 2'));
    });
  });

  group('the top header keeps the NEW display face', () {
    test('headerTitle is Kilimanjaro Sans', () {
      expect(OnboardingTypography.headerTitle().fontFamily, kNew);
    });

    test('and the app display family is unchanged', () {
      expect(OnboardingTypography.displayFamily, kNew);
    });

    test('the two faces are genuinely different', () {
      expect(
        OnboardingTypography.formQuestionHeadline().fontFamily,
        isNot(OnboardingTypography.headerTitle().fontFamily),
        reason: 'the whole point of the split: the question and the header must '
            'not render in the same face',
      );
    });
  });

  group('the body face never moved', () {
    test('an option card subtitle and the why-text stay on Inter', () {
      expect(OnboardingTypography.formCardSubtitle().fontFamily, 'Inter');
      expect(OnboardingTypography.formWhyText().fontFamily, 'Inter');
    });
  });
}
