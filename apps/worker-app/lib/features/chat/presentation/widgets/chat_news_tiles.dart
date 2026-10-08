import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/onboarding_theme.dart';
import '../../domain/chat_news_link.dart';

/// ADR-0054 §3.4 (#2148) — the "read more" tiles under a free-chat news answer.
///
/// The summary is the bot's own bubble; these are the sources it was written
/// from. One tile per link, in served order, drawn ONLY when the turn carried
/// some — a turn with none renders nothing at all, not an empty frame.
///
/// Tapping one leaves the app for the external browser. That is deliberate: the
/// article is someone else's page, and dressing it as part of BadaBhai would
/// claim an editorial relationship with it that does not exist.
class ChatNewsTiles extends StatelessWidget {
  const ChatNewsTiles({
    super.key,
    required this.links,
    this.onOpen,
  });

  final List<ChatNewsLink> links;

  /// Injected so a widget test never stands up the real platform channel. The
  /// production default opens the system browser.
  final Future<bool> Function(Uri url)? onOpen;

  static Future<bool> _defaultOpen(Uri url) =>
      launchUrl(url, mode: LaunchMode.externalApplication);

  @override
  Widget build(BuildContext context) {
    if (links.isEmpty) return const SizedBox.shrink();
    final Future<bool> Function(Uri) open = onOpen ?? _defaultOpen;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.s2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (final ChatNewsLink link in links) ...<Widget>[
            _NewsTile(link: link, onOpen: open),
            const SizedBox(height: AppSpacing.s2),
          ],
        ],
      ),
    );
  }
}

/// One tile: the headline, the site it came from, and the affordance that says
/// tapping leaves the app.
class _NewsTile extends StatelessWidget {
  const _NewsTile({required this.link, required this.onOpen});

  final ChatNewsLink link;
  final Future<bool> Function(Uri url) onOpen;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      link: true,
      // The site rides the label: a worker deciding whether to tap wants to
      // know where it goes, and a screen reader cannot see the line below.
      label: '${link.title} — ${link.site}, $kChatNewsReadMoreLabel',
      child: ExcludeSemantics(
        child: Material(
          color: OnboardingColors.paperWhite,
          borderRadius: BorderRadius.circular(OnboardingRadii.card),
          child: InkWell(
            borderRadius: BorderRadius.circular(OnboardingRadii.card),
            onTap: () => onOpen(link.url),
            child: Container(
              constraints: const BoxConstraints(
                minHeight: OnboardingLayout.tapTarget,
              ),
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.s3,
                vertical: AppSpacing.s2,
              ),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(OnboardingRadii.card),
                border: Border.all(color: OnboardingColors.borderDefault),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    link.title,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.inter(
                      size: 14,
                      weight: FontWeight.w700,
                      color: OnboardingColors.shiftBlue,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Row(
                    children: <Widget>[
                      Flexible(
                        child: Text(
                          link.site,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: OnboardingTypography.inter(
                            size: 12,
                            color: OnboardingColors.ink600,
                          ),
                        ),
                      ),
                      const SizedBox(width: AppSpacing.s2),
                      Text(
                        kChatNewsReadMoreLabel,
                        style: OnboardingTypography.inter(
                          size: 12,
                          weight: FontWeight.w700,
                          color: OnboardingColors.shiftBlue,
                        ),
                      ),
                      const SizedBox(width: 2),
                      const Icon(
                        Icons.open_in_new,
                        size: 14,
                        color: OnboardingColors.shiftBlue,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The affordance's words. Hinglish, like the rest of the chat's own copy.
const String kChatNewsReadMoreLabel = 'Aur padhiye';
