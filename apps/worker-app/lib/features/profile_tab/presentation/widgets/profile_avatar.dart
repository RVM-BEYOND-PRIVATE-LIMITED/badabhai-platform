import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../../../core/di/locator.dart';
import '../../../../core/error/failure.dart';
import '../../../../core/error/failure_mapper.dart';
import '../../../../core/error/failure_reason.dart';
import '../../../../core/nav/tab_focus.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../resume/domain/photo_repository.dart';
import '../../../resume/presentation/widgets/photo_picker_sheet.dart';

/// Diameter of the Profile avatar (unchanged from the initials/icon it replaces).
const double _kAvatarSize = 72;

/// The edit affordance's tap target. 44dp is the floor for a comfortable tap —
/// the visible badge is smaller, so the InkWell is sized to the target, not the
/// glyph.
const double _kEditTapTarget = 44;

/// ADR-0032 — the worker's photo on the Profile tab, with the edit entry point.
///
/// SECOND entry point to the ONE photo per worker: it drives the same
/// [runPhotoFlow] and the same [PhotoRepository] as the resume-edit screen, so a
/// change in either place is the same change. There is no local copy and no
/// second photo concept.
///
/// FAIL-SILENT on read (mirrors ResumePhotoHeader): any fetch failure — offline,
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
            _avatar(),
            if (widget.verified && widget.verifiedBadge != null)
              Positioned(right: -2, bottom: -2, child: widget.verifiedBadge!),
            Positioned(
              left: -6,
              bottom: -6,
              child: _editBadge(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _avatar() {
    final String? url = _url;
    return Container(
      width: _kAvatarSize,
      height: _kAvatarSize,
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[AppColors.saffron300, AppColors.saffron200],
        ),
      ),
      alignment: Alignment.center,
      clipBehavior: Clip.antiAlias,
      child: url == null
          ? _placeholder()
          : Image.network(
              url,
              width: _kAvatarSize,
              height: _kAvatarSize,
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
        ? const Icon(Icons.person_rounded,
            size: 36, color: AppColors.vermilion800)
        : Text(
            initials,
            // Design tokens, not raw values — identical to the initials this
            // avatar replaced.
            style: AppTypography.display(
              size: AppTypography.size2xl,
              weight: FontWeight.w800,
              color: AppColors.vermilion800,
            ),
          );
  }

  Widget _editBadge() {
    return Semantics(
      button: true,
      label: _url == null ? 'Photo lagayein' : 'Photo badlein',
      child: SizedBox(
        width: _kEditTapTarget,
        height: _kEditTapTarget,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: _busy ? null : _edit,
            child: Center(
              child: Container(
                width: 26,
                height: 26,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: AppColors.brand,
                ),
                alignment: Alignment.center,
                child: _busy
                    ? const SizedBox(
                        width: 12,
                        height: 12,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: AppColors.textOnBrand,
                        ),
                      )
                    : const Icon(Icons.photo_camera_rounded,
                        size: 14, color: AppColors.textOnBrand),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
