import 'package:flutter/material.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../domain/photo_repository.dart';
import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';

/// ADR-0032 — the photo strip at the top of the resume preview card.
///
/// Renders the worker's OWN photo ONLY when `show_photo && has_photo` (this is
/// what makes the "Photo dikhayein" toggle actually gate something). Entirely
/// self-contained and FAIL-SILENT: any error (offline, session, feature
/// dormant) collapses to nothing — the resume text is the product; the photo is
/// garnish and must never cost the worker their preview. The signed url lives
/// in widget state only (never persisted/logged) and is re-fetched on mount.
class ResumePhotoHeader extends StatefulWidget {
  const ResumePhotoHeader({super.key});

  @override
  State<ResumePhotoHeader> createState() => _ResumePhotoHeaderState();
}

class _ResumePhotoHeaderState extends State<ResumePhotoHeader> {
  String? _url;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final ResumeSafeFields fields =
          await locator<ResumeEditRepository>().load();
      if (!mounted || !fields.showPhoto || !fields.hasPhoto) return;
      final String? url = await locator<PhotoRepository>().photoUrl();
      if (!mounted || url == null) return;
      setState(() => _url = url);
    } catch (_) {
      // Fail-silent by design: no photo strip, never an error.
    }
  }

  @override
  Widget build(BuildContext context) {
    final String? url = _url;
    if (url == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(
        top: AppSpacing.s4,
        left: AppSpacing.s4,
        right: AppSpacing.s4,
      ),
      child: Row(
        children: <Widget>[
          CircleAvatar(
            radius: 28,
            backgroundColor: AppColors.divider,
            child: ClipOval(
              child: Image.network(
                url,
                width: 56,
                height: 56,
                fit: BoxFit.cover,
                // Expired signed url / offline → vanish, never an error box.
                errorBuilder: (_, __, ___) => const SizedBox.shrink(),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
