import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/kit/kit_card.dart';
import '../../../../core/widgets/kit/kit_pill.dart';
import '../../../../core/widgets/kit/kit_salary_box.dart';
import '../../../../router.dart';
import '../../domain/photo_repository.dart';
import '../../domain/resume_edit_repository.dart';
import '../../domain/resume_safe_fields.dart';
import 'resume_card_slots.dart';

/// Spec §4 card 1 — the worker's own identity block: photo, name, status, the
/// trade verdict, the expected salary, and the two actions.
///
/// SELF-CONTAINED AND FAIL-SILENT, which is why it still reads its own data
/// instead of taking it from [ResumeCubit]: it fetches the §2-safe fields
/// (name + photo pointer) and, when a photo exists, its short-lived signed
/// url. A failure leaves a neutral placeholder avatar and a name-free card —
/// the photo and the name spelling are garnish, and must NEVER cost the
/// worker the resume underneath them. (This is the old `ResumePhotoHeader`,
/// folded into the card the spec draws.)
///
/// Re-keyed by the caller on every return from the editor, so a photo or
/// spelling the worker just changed is re-fetched rather than showing
/// mount-time state — the header loads in `initState` only, so a new State is
/// the mechanism.
class ResumeProfileCard extends StatefulWidget {
  const ResumeProfileCard({
    super.key,
    required this.facts,
    required this.actions,
    required this.onEditReturned,
    this.profileConfirmed,
  });

  /// The trade verdict / city line / expected salary for whichever document
  /// shape this worker has — see [resolveProfileFacts]. Every part is
  /// nullable and every null hides its line.
  final ResumeProfileFacts facts;

  /// The share + download row (see `ResumeActionRow`). Passed in so this card
  /// never owns share or download behaviour.
  final Widget actions;

  /// Called when the editor pops, with TRUE when the worker's NAME changed.
  final ValueChanged<bool> onEditReturned;

  /// R7 — `false` shows the DRAFT pill; `true` and `null` both hide it. An
  /// unknown profile status must never accuse a worker's resume of being a
  /// draft.
  final bool? profileConfirmed;

  @override
  State<ResumeProfileCard> createState() => _ResumeProfileCardState();
}

class _ResumeProfileCardState extends State<ResumeProfileCard> {
  ResumeSafeFields? _fields;
  String? _photoUrl;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final ResumeSafeFields fields = await locator<ResumeEditRepository>()
          .load();
      String? url;
      // Fetch the URL whenever a photo exists on the server — showPhoto only
      // controls DISPLAY, not URL availability.
      if (fields.hasPhoto) {
        url = await locator<PhotoRepository>().photoUrl();
      }
      if (!mounted) return;
      setState(() {
        _fields = fields;
        _photoUrl = url;
      });
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final ResumeSafeFields? fields = _fields;
    final String name = fields?.displayName ?? '';
    final bool showPhoto = fields?.showPhoto ?? false;
    final String? url = _photoUrl;
    final ResumeProfileFacts facts = widget.facts;

    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _Avatar(showPhoto: showPhoto, url: url),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        if (name.isNotEmpty)
                          Expanded(
                            child: Text(
                              name,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: OnboardingTypography.anek(
                                size: 18,
                                weight: FontWeight.w800,
                              ),
                            ),
                          )
                        else
                          const Spacer(),
                        const SizedBox(width: 8),
                        _EditResumeButton(onReturned: widget.onEditReturned),
                      ],
                    ),
                    const SizedBox(height: 3),
                    // A Wrap, not a Row: at a large system font the pill drops
                    // under the label rather than squeezing it to an ellipsis.
                    Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 6,
                      runSpacing: 4,
                      children: <Widget>[
                        Text(
                          'WORKER PROFILE',
                          style: OnboardingTypography.inter(
                            size: 10,
                            weight: FontWeight.w700,
                            color: OnboardingColors.ink600,
                          ),
                        ),
                        if (widget.profileConfirmed == false)
                          const KitPill(
                            label: 'DRAFT',
                            tone: KitPillTone.neutral,
                            fontSize: 9,
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (facts.subtitle != null) ...<Widget>[
            const SizedBox(height: 12),
            Text(
              facts.subtitle!,
              style: OnboardingTypography.inter(
                size: 13,
                weight: FontWeight.w600,
                height: 1.35,
              ),
            ),
          ],
          if (facts.secondLine != null) ...<Widget>[
            const SizedBox(height: 4),
            Text(
              facts.secondLine!,
              style: OnboardingTypography.inter(
                size: 12,
                height: 1.35,
                color: OnboardingColors.ink600,
              ),
            ),
          ],
          if (facts.salary != null) ...<Widget>[
            const SizedBox(height: 14),
            KitSalaryBox(label: 'Expected Salary', value: facts.salary!),
          ],
          const SizedBox(height: 14),
          widget.actions,
        ],
      ),
    );
  }
}

/// The worker's photo, or a neutral placeholder. 56dp across (spec radius 28).
class _Avatar extends StatelessWidget {
  const _Avatar({required this.showPhoto, required this.url});

  final bool showPhoto;
  final String? url;

  static const double _kRadius = 28;
  static const double _kSize = _kRadius * 2;

  @override
  Widget build(BuildContext context) {
    final String? src = url;
    if (showPhoto && src != null) {
      // Decode to the on-screen size, not the photo's full resolution.
      final int cachePx = (_kSize * MediaQuery.devicePixelRatioOf(context))
          .round();
      return CircleAvatar(
        radius: _kRadius,
        backgroundColor: OnboardingColors.borderDefault,
        child: ClipOval(
          child: Image.network(
            src,
            width: _kSize,
            height: _kSize,
            cacheWidth: cachePx,
            cacheHeight: cachePx,
            fit: BoxFit.cover,
            // Signed url expired / offline → the placeholder, never an error.
            errorBuilder: (_, __, ___) => const Icon(
              Icons.person_rounded,
              size: 32,
              color: OnboardingColors.safetyYellow,
            ),
          ),
        ),
      );
    }
    return const CircleAvatar(
      radius: _kRadius,
      backgroundColor: OnboardingColors.selectedCardBg,
      child: Icon(
        Icons.person_rounded,
        size: 32,
        color: OnboardingColors.safetyYellow,
      ),
    );
  }
}

/// The card-row 'Edit' affordance — the ONLY route to the safe-field editor.
///
/// Reads 'Edit' (it sits inside the worker's own profile card, where "Edit
/// resume" would repeat what the card already says) but keeps the FULL
/// accessible name 'Edit resume', so a screen-reader user hears which Edit
/// this is. The label is excluded from semantics so the two do not merge into
/// "Edit resume Edit".
///
/// Gated on `changed == true` deliberately: the editor pops `true` only when
/// the NAME actually changed, and an unconditional regenerate would spend one
/// of the worker's 5 daily generates and bin the rendered PDF on every
/// prefs-only save.
class _EditResumeButton extends StatelessWidget {
  const _EditResumeButton({required this.onReturned});

  final ValueChanged<bool> onReturned;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: 'Edit resume',
      child: OutlinedButton(
        key: const Key('resume-edit-button'),
        style: OutlinedButton.styleFrom(
          // Spec padding is h10 v4 (a ~28dp visual). `padded` keeps the paint
          // that small while the HIT area clears the 48dp worker floor.
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          minimumSize: const Size(
            OnboardingLayout.tapTarget,
            OnboardingLayout.tapTarget,
          ),
          tapTargetSize: MaterialTapTargetSize.padded,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          side: const BorderSide(color: OnboardingColors.borderDefault),
          foregroundColor: OnboardingColors.ink900,
          textStyle: OnboardingTypography.inter(
            size: 12,
            weight: FontWeight.w600,
          ),
        ),
        onPressed: () async {
          // The editor pops `true` only when the name actually changed; a
          // dismissed screen pops null.
          final bool? changed = await context.push<bool>(Routes.resumeEdit);
          onReturned(changed == true);
        },
        child: const ExcludeSemantics(child: Text('Edit')),
      ),
    );
  }
}
