import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme/onboarding_theme.dart';

/// #3049 — the worker app's update copy, in English and Latin-script Hindi,
/// matching the rest of the worker screens.
class UpdateCopy {
  const UpdateCopy({
    required this.requiredTitle,
    required this.requiredBody,
    required this.updateAction,
    required this.retryAction,
    required this.noticeTitle,
    required this.noticeBody,
    required this.laterAction,
  });

  final String requiredTitle;
  final String requiredBody;
  final String updateAction;
  final String retryAction;
  final String noticeTitle;
  final String noticeBody;
  final String laterAction;

  static UpdateCopy forLanguage(String language) =>
      language == 'hi' ? _hindi : _english;

  static const UpdateCopy _english = UpdateCopy(
    requiredTitle: 'Update required',
    requiredBody:
        'This version of the BadaBhai app is no longer supported. Please update to keep using the app.',
    updateAction: 'Update app',
    retryAction: 'Try again',
    noticeTitle: 'A new version is available',
    noticeBody:
        'A newer version of the BadaBhai app is ready. Update to get it.',
    laterAction: 'Later',
  );

  static const UpdateCopy _hindi = UpdateCopy(
    requiredTitle: 'App update karein',
    requiredBody:
        'BadaBhai app ka ye version ab support nahi karta. App use karte rehne ke liye update karein.',
    updateAction: 'App update karein',
    retryAction: 'Dobara try karein',
    noticeTitle: 'Naya version aa gaya hai',
    noticeBody:
        'BadaBhai app ka naya version taiyar hai. Update karke use karein.',
    laterAction: 'Baad mein',
  );
}

/// The full-screen, non-dismissible page a build below the minimum sees.
class UpdateRequiredScreen extends StatelessWidget {
  const UpdateRequiredScreen({
    super.key,
    required this.language,
    required this.storeUrl,
    this.onRetry,
  });

  final String language;
  final String? storeUrl;
  final Future<void> Function()? onRetry;

  Future<void> _openOrRetry() async {
    final String? url = storeUrl;
    if (url != null && url.startsWith('https://')) {
      final Uri? uri = Uri.tryParse(url);
      if (uri != null) {
        try {
          await launchUrl(uri, mode: LaunchMode.externalApplication);
          return;
        } catch (_) {
          // Fall through to retry; the page never traps the worker.
        }
      }
    }
    await onRetry?.call();
  }

  @override
  Widget build(BuildContext context) {
    final UpdateCopy copy = UpdateCopy.forLanguage(language);
    return Scaffold(
      backgroundColor: OnboardingColors.shiftBlue,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                const Icon(
                  Icons.system_update_rounded,
                  color: OnboardingColors.safetyYellow,
                  size: 64,
                ),
                const SizedBox(height: 24),
                Text(
                  copy.requiredTitle,
                  textAlign: TextAlign.center,
                  style: OnboardingTypography.anek(
                    size: 28,
                    weight: FontWeight.w800,
                    color: OnboardingColors.paperWhite,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  copy.requiredBody,
                  textAlign: TextAlign.center,
                  style: OnboardingTypography.inter(
                    size: 15,
                    height: 1.5,
                    color: OnboardingColors.paperWhite.withValues(alpha: 0.85),
                  ),
                ),
                const SizedBox(height: 32),
                SizedBox(
                  height: 52,
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      backgroundColor: OnboardingColors.safetyYellow,
                      foregroundColor: OnboardingColors.shiftBlue,
                      textStyle: OnboardingTypography.inter(
                        size: 16,
                        weight: FontWeight.w700,
                        color: OnboardingColors.shiftBlue,
                      ),
                    ),
                    onPressed: () => _openOrRetry(),
                    child: Text(
                      storeUrl == null ? copy.retryAction : copy.updateAction,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The dismissible once-a-day notice a build below `latest_build` sees.
class UpdateNoticeBanner extends StatelessWidget {
  const UpdateNoticeBanner({
    super.key,
    required this.language,
    required this.storeUrl,
    required this.onDismiss,
  });

  final String language;
  final String? storeUrl;
  final VoidCallback onDismiss;

  Future<void> _open() async {
    final String? url = storeUrl;
    if (url == null || !url.startsWith('https://')) return;
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // The notice is not worth an error; Later closes it.
    }
  }

  @override
  Widget build(BuildContext context) {
    final UpdateCopy copy = UpdateCopy.forLanguage(language);
    return Material(
      color: OnboardingColors.shiftBlue,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Icon(
                Icons.system_update_rounded,
                color: OnboardingColors.safetyYellow,
                size: 22,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      copy.noticeTitle,
                      style: OnboardingTypography.inter(
                        size: 14,
                        weight: FontWeight.w700,
                        color: OnboardingColors.paperWhite,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      copy.noticeBody,
                      style: OnboardingTypography.inter(
                        size: 12,
                        height: 1.35,
                        color: OnboardingColors.paperWhite.withValues(
                          alpha: 0.85,
                        ),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      children: <Widget>[
                        TextButton(
                          onPressed: () => _open(),
                          child: Text(
                            copy.updateAction,
                            style: OnboardingTypography.inter(
                              size: 13,
                              weight: FontWeight.w700,
                              color: OnboardingColors.safetyYellow,
                            ),
                          ),
                        ),
                        TextButton(
                          onPressed: onDismiss,
                          child: Text(
                            copy.laterAction,
                            style: OnboardingTypography.inter(
                              size: 13,
                              color: OnboardingColors.paperWhite.withValues(
                                alpha: 0.8,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
