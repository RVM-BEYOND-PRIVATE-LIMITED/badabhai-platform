import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/taxonomy_labels.dart';
import '../../../../core/widgets/bb_verified_badge.dart';
import '../../../../core/widgets/kit/kit_card.dart';
import '../../../../core/widgets/kit/kit_pill.dart';
import '../../domain/profile_summary.dart';
import 'profile_avatar.dart';

/// "4 saal" / "2.5 saal" — a trailing ".0" is dropped so whole years read
/// cleanly. Shared by this card's subtitle and the Profile tab's experience
/// row, so the same number is never formatted two ways on one screen.
String profileExperienceLabel(double years) {
  final bool whole = years == years.roundToDouble();
  final String n = whole ? years.toStringAsFixed(0) : years.toStringAsFixed(1);
  return '$n saal';
}

/// The worker-facing label for a raw `profile_status`, or `null` when there is
/// nothing honest to say.
///
/// The raw values are `none | draft | extracting | extracted | confirmed`, and
/// a worker must never see one of them (the "no raw ids in UI" rule). Only the
/// in-progress family gets a pill:
///  - `draft` / `extracting` / `extracted` → 'DRAFT' (the profile is not
///    confirmed yet, which is a real, useful state);
///  - `confirmed` and `none` → NOTHING. 'CONFIRMED' has no approved worker
///    label yet (copy conflict C28) and a pill reading 'NONE' would be noise,
///    so the pill is hidden rather than invented.
String? profileStatusLabel(String raw) => switch (raw.trim().toLowerCase()) {
  'draft' || 'extracting' || 'extracted' => 'DRAFT',
  _ => null,
};

/// A monogram derived from a REAL name — never fabricated.
///
/// Takes the first letter of the first two words ("Ramesh Kumar" → "RK"), or
/// the single initial of a one-word name. Returns null for an empty/blank
/// name, so the avatar falls back to its neutral person glyph instead of
/// showing a letter nobody gave us.
String? profileInitials(String? name) {
  final String trimmed = (name ?? '').trim();
  if (trimmed.isEmpty) return null;
  final List<String> words = trimmed
      .split(RegExp(r'\s+'))
      .where((String w) => w.isNotEmpty)
      .toList();
  if (words.isEmpty) return null;
  final String letters = words.take(2).map((String w) => w[0]).join();
  return letters.toUpperCase();
}

/// The worker's identity, as the v3 profile card (spec §4): photo, name, a
/// micro label with the honest profile state, and a one-line summary of the
/// facts they actually gave.
///
/// It used to be painted INTO the blue header, which made the header three
/// times taller than the artboard's and put white text on navy at every text
/// scale. v3 moves it into the first card of the list, where it can wrap.
///
/// REAL DATA ONLY. Every part is dropped when its source is absent: no name,
/// no trade, no city, no experience, no status pill. Nothing is invented — the
/// name is the worker's own spelling (`GET /workers/me/resume-fields`, ruling
/// R5) and the trade/skill labels are canonical taxonomy strings, humanized at
/// this edge so a raw `role_*` id can never reach the screen.
///
/// There is deliberately no salary, share or download here: the Resume tab
/// owns those, and duplicating them would give the worker two places to look.
class ProfileIdentityCard extends StatelessWidget {
  const ProfileIdentityCard({
    super.key,
    required this.summary,
    this.displayName,
  });

  final ProfileSummary summary;

  /// The name read separately from the resume fields (ruling R5). It wins over
  /// [ProfileSummary.displayName], which the profile-summary wire still omits.
  final String? displayName;

  @override
  Widget build(BuildContext context) {
    final String? name = _firstNonEmpty(<String?>[
      displayName,
      summary.displayName,
    ]);
    final String trade = replaceTaxonomyIds(summary.tradeLabel ?? '').trim();

    // A name leads when there is one; otherwise the trade does. 'Aapki profile'
    // is the last resort — a neutral card title, never presented as a name.
    final String title = name ?? (trade.isNotEmpty ? trade : 'Aapki profile');
    final String? status = profileStatusLabel(summary.profileStatus);

    final double? years = summary.experienceYears;
    final String? city = _firstNonEmpty(<String?>[summary.city]);
    final List<String> subParts = <String>[
      // Only repeat the trade below when the NAME is the headline, so the card
      // never prints the same words twice.
      if (name != null && trade.isNotEmpty) trade,
      if (years != null) profileExperienceLabel(years),
      if (city != null) city,
    ];

    return KitCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          // ADR-0032 — the worker's real photo, with the edit entry point. Same
          // photo, same endpoints, same shared sheet — no second concept.
          ProfileAvatar(
            initials: summary.initials ?? profileInitials(name),
            // #1586 — the seal/pill render on SERVER ATTESTATION, never on
            // profile confirmation. A confirmed-but-unattested worker shows
            // neither, and there is deliberately no "Unverified" counterpart.
            verified: summary.attested,
            verifiedBadge: const BbSeal(),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.anek(
                    size: 18,
                    weight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 6),
                // Wrap, not Row: at a large system font the pill drops under
                // the label instead of squeezing it to an ellipsis.
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 6,
                  runSpacing: 4,
                  children: <Widget>[
                    Text(
                      'WORKER PROFILE',
                      style: OnboardingTypography.microLabel(
                        color: OnboardingColors.ink600,
                      ),
                    ),
                    if (status != null) KitPill(label: status, fontSize: 9),
                  ],
                ),
                if (subParts.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 12),
                  Text(
                    subParts.join(' • '),
                    style: OnboardingTypography.inter(
                      size: 13,
                      weight: FontWeight.w600,
                      height: 1.35,
                    ),
                  ),
                ],
                if (summary.attested) ...<Widget>[
                  const SizedBox(height: 10),
                  // The badge lays its icon and label out in a Row with NO
                  // flexible child, so at a 2.0 system font it asks for 211dp
                  // inside this 168dp column and overflows (measured at
                  // 320x568). It is a status marker, not body copy, so it
                  // clamps with the rest of the chrome at 1.3 — and the
                  // scale-down is the belt to that braces, in case a caller
                  // ever passes a longer label.
                  MediaQuery.withClampedTextScaling(
                    maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
                    child: const FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: BbVerifiedBadge(),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The first value that carries actual text; null when none does.
  static String? _firstNonEmpty(List<String?> values) {
    for (final String? value in values) {
      final String trimmed = (value ?? '').trim();
      if (trimmed.isNotEmpty) return trimmed;
    }
    return null;
  }
}
