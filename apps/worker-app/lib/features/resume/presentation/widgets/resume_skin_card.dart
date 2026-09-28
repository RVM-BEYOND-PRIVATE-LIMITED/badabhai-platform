import 'package:flutter/material.dart';

import '../../../../core/api/api_models.dart'
    show ResumeSkinChange, ResumeSkinState;
import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_reason.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/kit/kit_card.dart';
import '../../domain/resume_repository.dart';
import 'resume_document_view.dart' show kResumeCardGap;

/// RÉSUMÉ SKINS (#1808) — the picker and its live preview on the Résumé tab.
///
/// DRAWS NOTHING UNLESS THE SERVER SAYS SO. `GET /resume/skin` answers
/// `enabled: false` while `RESUME_SKINS_ENABLED` is off — which is every box
/// today — and every failure reads the same way, so this ships dark and the tab
/// is byte-identical until the owner turns the flag on.
///
/// ONE SKIN IS NOT A CHOICE. `skins` is `["neela"]` today (Saada, Kaagaz and
/// Loha have no approved tokens yet), so the card renders READ-ONLY: the worker
/// still learns which skin their sheet prints in, and nothing pretends to be
/// tappable. The moment the server serves a second skin the same card becomes
/// selectable, with no release in between.
///
/// THE NAMES AND THE SWATCHES ARE THE APP'S, and deliberately so — the server's
/// own DTO says it ("skin names, swatches and the live preview are the app's").
/// The wire carries ids only.
class ResumeSkinCard extends StatefulWidget {
  const ResumeSkinCard({super.key, this.repository});

  /// Injectable ONLY so a test can supply a fake; production resolves the
  /// registered one. Not required, on the same terms as `ResumeCubit`'s
  /// optional summary repository: a partially-wired widget test must not fail
  /// because of an optional card.
  final ResumeRepository? repository;

  @override
  State<ResumeSkinCard> createState() => _ResumeSkinCardState();
}

class _ResumeSkinCardState extends State<ResumeSkinCard> {
  ResumeSkinState _state = ResumeSkinState.disabled;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  ResumeRepository? get _repo {
    final ResumeRepository? injected = widget.repository;
    if (injected != null) return injected;
    return locator.isRegistered<ResumeRepository>()
        ? locator<ResumeRepository>()
        : null;
  }

  Future<void> _load() async {
    final ResumeRepository? repo = _repo;
    if (repo == null) return;
    // Never throws by contract — see [ResumeRepository.loadResumeSkin].
    final ResumeSkinState next = await repo.loadResumeSkin();
    if (!mounted) return;
    setState(() => _state = next);
  }

  Future<void> _choose(String skin) async {
    final ResumeRepository? repo = _repo;
    if (repo == null || _saving || skin == _state.skin) return;
    setState(() => _saving = true);
    try {
      final ResumeSkinChange change = await repo.chooseResumeSkin(skin);
      if (!mounted) return;
      setState(() => _state = ResumeSkinState(
            enabled: _state.enabled,
            skin: change.skin,
            skins: _state.skins,
          ));
    } on Failure catch (f) {
      if (!mounted) return;
      // A 409 means a concurrent DIFFERENT first choice won, so the honest
      // answer is to re-read rather than to keep showing a choice the server
      // did not take. Every other failure is surfaced with its real reason —
      // the worker tapped something deliberate (the #1353 rule).
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(failureReason(f).reason)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_state.enabled || _state.skins.isEmpty) {
      return const SizedBox.shrink();
    }
    final bool selectable = _state.canChoose && !_saving;
    // The trailing gap rides INSIDE the card: a hidden card must leave the
    // tab's spacing byte-identical, which a sibling SizedBox could not do.
    return Padding(
      padding: const EdgeInsets.only(bottom: kResumeCardGap),
      child: KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const KitCardHeader(
            icon: Icons.palette_outlined,
            title: kResumeSkinTitle,
          ),
          const SizedBox(height: 6),
          Text(
            selectable ? kResumeSkinSubtitle : kResumeSkinSingleSubtitle,
            style: OnboardingTypography.inter(
              size: 12,
              height: 1.35,
              color: OnboardingColors.ink500,
            ),
          ),
          const SizedBox(height: 12),
          for (final String skin in _state.skins) ...<Widget>[
            _SkinRow(
              skin: skin,
              selected: skin == _state.skin,
              onTap: selectable ? () => _choose(skin) : null,
            ),
            const SizedBox(height: 8),
          ],
        ],
        ),
      ),
    );
  }
}

/// The card's copy. Hinglish, aap-form, like every other card on this tab.
const String kResumeSkinTitle = 'Resume ka rang';
const String kResumeSkinSubtitle = 'Jo pasand ho wo chunein.';
const String kResumeSkinSingleSubtitle =
    'Abhi ek hi rang hai — aapka resume isi mein banta hai.';

/// One skin: its swatch, its name, and whether the sheet prints in it.
///
/// A null [onTap] is the read-only state — no ink, no button semantics, no
/// promise of a choice that does not exist yet.
class _SkinRow extends StatelessWidget {
  const _SkinRow({required this.skin, required this.selected, this.onTap});

  final String skin;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final ({String name, Color swatch}) look = resumeSkinLook(skin);
    final Widget row = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        // The app-wide SELECTED cue: a 1.8dp yellow border, never colour alone.
        border: Border.all(
          color: selected
              ? OnboardingColors.safetyYellow
              : OnboardingColors.borderCard,
          width: selected ? 1.8 : 1,
        ),
      ),
      child: Row(
        children: <Widget>[
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: look.swatch,
              borderRadius: BorderRadius.circular(8),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              look.name,
              style: OnboardingTypography.inter(
                size: 14,
                weight: FontWeight.w700,
                color: OnboardingColors.ink900,
              ),
            ),
          ),
          if (selected)
            Text(
              kResumeSkinCurrent,
              style: OnboardingTypography.inter(
                size: 12,
                weight: FontWeight.w700,
                color: OnboardingColors.ink600,
              ),
            ),
        ],
      ),
    );
    if (onTap == null) return Semantics(container: true, child: row);
    return Semantics(
      container: true,
      button: true,
      selected: selected,
      child: InkWell(
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        onTap: onTap,
        child: row,
      ),
    );
  }
}

/// What the worker's sheet prints in right now.
const String kResumeSkinCurrent = 'Abhi yahi';

/// The app's own name and swatch for a skin id (the wire carries ids only).
///
/// An id this build has never heard of gets its slug humanised rather than
/// printed raw (the no-raw-ids rule) and the house navy as its swatch, so a
/// server that adds a skin before the app does still renders something honest.
({String name, Color swatch}) resumeSkinLook(String skin) => switch (skin) {
      'neela' => (name: 'Neela', swatch: OnboardingColors.shiftBlue),
      _ => (
          name: skin.isEmpty
              ? 'Resume'
              : skin[0].toUpperCase() +
                  skin.substring(1).replaceAll(RegExp(r'[_\-]+'), ' '),
          swatch: OnboardingColors.shiftBlue,
        ),
    };
