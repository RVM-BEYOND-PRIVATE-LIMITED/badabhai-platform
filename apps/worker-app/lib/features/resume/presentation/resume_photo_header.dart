import 'package:flutter/material.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../domain/photo_repository.dart';
import '../domain/resume_edit_repository.dart';
import '../domain/resume_safe_fields.dart';

/// The resume card's header: the worker's photo, their name, and the
/// `WORKER PROFILE (DRAFT)` status line — the top block of the design.
///
/// Self-contained and fail-silent: it self-reads the §2-safe fields
/// (name + photo pointer) and, when a photo exists, its short-lived signed URL.
/// A load failure leaves a neutral placeholder avatar and a name-free header —
/// the photo/name are garnish and must never cost the worker their resume.
class ResumePhotoHeader extends StatefulWidget {
  const ResumePhotoHeader({super.key, this.isDraft = false});

  /// Whether the resume body is still a DRAFT (parsed from the resume text by
  /// the caller). Drives the "(DRAFT)" pill; never fabricated here.
  final bool isDraft;

  @override
  State<ResumePhotoHeader> createState() => _ResumePhotoHeaderState();
}

class _ResumePhotoHeaderState extends State<ResumePhotoHeader> {
  ResumeSafeFields? _fields;
  String? _photoUrl;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final ResumeSafeFields fields =
          await locator<ResumeEditRepository>().load();
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
    final String? url = _photoUrl;
    final String name = fields?.displayName ?? '';
    final bool showPhoto = fields?.showPhoto ?? false;
    final bool hasPhoto = url != null;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.s5,
        AppSpacing.s5,
        AppSpacing.s5,
        AppSpacing.s4,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          _avatar(
              context: context,
              showPhoto: showPhoto,
              hasPhoto: hasPhoto,
              url: url),
          const SizedBox(width: AppSpacing.s4),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                if (name.isNotEmpty) ...<Widget>[
                  Text(
                    name,
                    style: AppTypography.display(
                      size: AppTypography.sizeXl,
                      weight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.s1),
                ],
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        'WORKER PROFILE',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          weight: FontWeight.w700,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ),
                    if (widget.isDraft) ...<Widget>[
                      const SizedBox(width: AppSpacing.s2),
                      const _DraftPill(),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _avatar({
    required BuildContext context,
    required bool showPhoto,
    required bool hasPhoto,
    required String? url,
  }) {
    if (showPhoto && hasPhoto) {
      // Decode to the on-screen size, not the photo's full resolution.
      final int cachePx =
          (60 * MediaQuery.devicePixelRatioOf(context)).round();
      return CircleAvatar(
        radius: 30,
        backgroundColor: AppColors.divider,
        child: ClipOval(
          child: Image.network(
            url!,
            width: 60,
            height: 60,
            cacheWidth: cachePx,
            cacheHeight: cachePx,
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) =>
                const Icon(Icons.person, size: 30, color: AppColors.textMuted),
          ),
        ),
      );
    }
    return const CircleAvatar(
      radius: 30,
      backgroundColor: AppColors.saffron100,
      child: Icon(Icons.person, size: 30, color: AppColors.ink700),
    );
  }
}

/// The grey "(DRAFT)" pill beside the WORKER PROFILE label.
class _DraftPill extends StatelessWidget {
  const _DraftPill();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.s2,
        vertical: AppSpacing.s1 / 2,
      ),
      decoration: BoxDecoration(
        color: AppColors.paper3,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        '(DRAFT)',
        style: AppTypography.body(
          size: AppTypography.sizeXs,
          weight: FontWeight.w700,
          color: AppColors.textSecondary,
        ),
      ),
    );
  }
}
