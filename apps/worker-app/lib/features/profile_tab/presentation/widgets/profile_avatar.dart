import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../../../core/error/failure_reason.dart';
import '../../../../core/nav/tab_focus.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../../resume/domain/photo_repository.dart';
import '../../../resume/presentation/widgets/photo_picker_sheet.dart';

/// Diameter of the Profile avatar.
///
/// 56, not the 72 it used to be: the avatar now sits in the v3 profile CARD
/// beside the name and the facts (spec §4), not alone on a blue header band,
/// so a 72dp disc left the name column too narrow to wrap at a large system
/// font.
const double _kAvatarSize = 56;

/// ADR-0032 — the worker's photo on the Profile tab, with the edit entry point.
///
/// SECOND entry point to the ONE photo per worker: it drives the same
/// [runPhotoFlow] and the same [PhotoRepository] as the resume-edit screen, so a
/// change in either place is the same change. There is no local copy and no
/// second photo concept.
///
/// FAIL-SILENT on read (mirrors `ResumeProfileCard`): any fetch failure — offline,
/// session gone, photos dormant (503) — collapses to the placeholder the tab
/// already showed. The Profile tab is the worker's identity screen; a photo
/// hiccup must never cost them their profile. A failure to CHANGE the photo is
/// different and is surfaced honestly: they asked for that, so they deserve to
/// know it did not happen.
///
/// DESIGN NOTE (as specified): the avatar shows the photo whenever one exists,
/// REGARDLESS of the `show_photo` pref. show_photo is a RESUME pref — it governs
/// the PDF/preview only, not whether the worker can see their own face in their
/// own profile.
///
/// PRIVACY: the signed URL is a bearer credential — fetched on view, held in
/// widget state only. Never logged, never persisted, never handed to another app.
class ProfileAvatar extends StatefulWidget {
  const ProfileAvatar({
    super.key,
    required this.initials,
    required this.verified,
    this.verifiedBadge,
  });

  /// Worker initials for the placeholder, or null for the neutral person icon
  /// (never a fabricated monogram).
  final String? initials;

  final bool verified;

  /// The existing verified seal, rendered over the avatar when [verified].
  final Widget? verifiedBadge;

  @override
  State<ProfileAvatar> createState() => _ProfileAvatarState();
}

class _ProfileAvatarState extends State<ProfileAvatar> {
  String? _url;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// Re-reads the photo. Fail-silent: a failure leaves the placeholder rather
  /// than an error box.
  Future<void> _load() async {
    try {
      final String? url = await locator<PhotoRepository>().photoUrl();
      if (!mounted) return;
      setState(() => _url = url); // null = no photo (404) → placeholder
    } catch (_) {
      if (!mounted) return;
      setState(() => _url = null);
    }
  }

  Future<void> _edit() async {
    if (_busy) return; // re-entrancy: a second tap must not race the first
    await runPhotoFlow(
      context,
      // A photo exists iff we resolved a url for one — no extra round-trip just
      // to decide whether "Photo hatayein" belongs in the sheet.
      hasPhoto: _url != null,
      onUpload: (Uint8List bytes) =>
          _run(() => locator<PhotoRepository>().uploadPhoto(bytes)),
      onRemove: () => _run(() => locator<PhotoRepository>().removePhoto()),
    );
  }

  /// Runs a photo CHANGE, then re-reads so the tab shows the new truth.
  ///
  /// Unlike the read, a failure here IS surfaced: the worker asked for this. The
  /// copy comes from [failureReason] — the server's 2MB / JPEG-PNG 400 and the
  /// dormant-photos 503 each get their honest line, never a raw error string.
  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
    } catch (error) {
      if (!mounted) return;
      final Failure failure = mapError(error);
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(failureReason(failure).reason)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // The shell keeps this branch mounted, so initState runs once — refetch when
    // the tab comes back into view, or a photo changed on the resume-edit screen
    // would never appear here (B3).
    return TabFocusRefetch(
      tabFocus: locator<TabFocus>(),
      index: TabIndex.profile,
      onFocused: _load,
      child: SizedBox(
        width: _kAvatarSize,
        height: _kAvatarSize,
        child: Stack(
          clipBehavior: Clip.none,
          children: <Widget>[
            _avatar(context),
            if (widget.verified && widget.verifiedBadge != null)
              Positioned(right: -2, bottom: -2, child: widget.verifiedBadge!),
            Positioned(left: -6, bottom: -6, child: _editBadge()),
          ],
        ),
      ),
    );
  }

  Widget _avatar(BuildContext context) {
    final String? url = _url;
    // Decode the photo to the on-screen pixel size, not its full source
    // resolution — a 2MB upload rendered into a 56px circle would otherwise
    // decode to tens of MB of bitmap and churn memory on low-RAM devices.
    final int cachePx = (_kAvatarSize * MediaQuery.devicePixelRatioOf(context))
        .round();
    return Container(
      width: _kAvatarSize,
      height: _kAvatarSize,
      // The v3 selected-card wash (#FFFBEB) — a warm disc behind the glyph,
      // flat, no gradient.
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        color: OnboardingColors.selectedCardBg,
      ),
      alignment: Alignment.center,
      clipBehavior: Clip.antiAlias,
      child: url == null
          ? _placeholder()
          : Image.network(
              url,
              width: _kAvatarSize,
              height: _kAvatarSize,
              cacheWidth: cachePx,
              cacheHeight: cachePx,
              fit: BoxFit.cover,
              // Expired signed url / offline → fall back to the placeholder,
              // never an error box.
              errorBuilder: (_, __, ___) => _placeholder(),
            ),
    );
  }

  /// Initials when a name exists; else a neutral person icon — the exact
  /// placeholder the tab showed before the photo existed.
  Widget _placeholder() {
    final String? initials = widget.initials;
    return initials == null
        ? const Icon(
            Icons.person_rounded,
            size: 32,
            color: OnboardingColors.safetyYellow,
          )
        // The disc is a FIXED 56dp, so the initials on it cannot grow: at a
        // 2.0 system font they rendered at 40pt and spilled out from under
        // both badges. scaleDown, NOT a text-scale clamp — `withClampedTextScaling`
        // asserts `maxScale > minScale`, and the app already pins a MINIMUM of
        // 1.0 (ruling R1), so a 1.0 ceiling there is an assertion, not a clamp.
        : FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              initials,
              // Design tokens, not raw values.
              style: OnboardingTypography.anek(
                size: 20,
                weight: FontWeight.w800,
                color: OnboardingColors.shiftBlue,
              ),
            ),
          );
  }

  Widget _editBadge() {
    return Semantics(
      button: true,
      label: _url == null ? 'Photo lagayein' : 'Photo badlein',
      child: SizedBox(
        // 48dp tap floor (worker app) — the visible badge glyph is smaller, so
        // the InkWell is sized to the target, not the glyph.
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: _busy ? null : _edit,
            // bottomLeft, NOT Center. `Positioned(left: -6, bottom: -6)`
            // offsets this 48dp TAP BOX; a centred 26dp glyph inside it
            // therefore landed 5dp INSIDE a 56dp avatar, on top of the
            // worker's initials, instead of overhanging its lower-left arc by
            // the 6dp the -6 asks for. Aligning the glyph to the box's corner
            // puts the paint where the offset means it, and the InkWell stays
            // 48dp.
            child: Align(
              alignment: Alignment.bottomLeft,
              child: Container(
                width: 26,
                height: 26,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: OnboardingColors.safetyYellow,
                ),
                alignment: Alignment.center,
                child: _busy
                    ? const SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: OnboardingColors.shiftBlue,
                        ),
                      )
                    : const Icon(
                        Icons.camera_alt_rounded,
                        size: 14,
                        color: OnboardingColors.shiftBlue,
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
