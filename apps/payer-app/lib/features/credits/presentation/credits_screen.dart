import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_config.dart';
import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/credits_screen_cubit.dart';

/// Opens an external URL. Overridable so widget tests can assert WHERE a link
/// went without a platform channel (`launchUrl` throws MissingPluginException
/// under `flutter test`). Mirrors the `ExternalUrlLauncher` seam in
/// `jobs_screen.dart`.
typedef CreditsUrlLauncher = Future<bool> Function(Uri url);

/// Production launcher: hand the url to the OS browser, never an in-app webview —
/// the payer signs in and pays on the web portal, outside this app.
Future<bool> defaultCreditsUrlLauncher(Uri url) =>
    launchUrl(url, mode: LaunchMode.externalApplication);

/// The seam the "buy credits on web" link leaves through. Production must always
/// leave this as [defaultCreditsUrlLauncher].
@visibleForTesting
CreditsUrlLauncher creditsExternalUrlLauncher = defaultCreditsUrlLauncher;

/// Label of the external affordance that REPLACED the in-app pack purchase.
const String kBuyCreditsOnWebLabel = 'Buy credits on web';

/// Says the missing capability out loud on the screen, so "where do I buy
/// credits?" is answered here instead of read as a bug — the same honesty the
/// Jobs screen applies to plans, boosts and quota top-ups.
const String kBuyCreditsOnWebNote =
    'Credit packs are bought on the BadaBhai website.';

/// Credits — the REAL balance (`GET /payer/credits`, ink card) and the REAL
/// credit ledger (`GET /payer/credits/ledger`), both READ-ONLY.
///
/// There is NO in-app purchase surface here. Selling a digital entitlement from
/// inside a store-distributed app is exactly what App Store / Play Store IAP
/// policy covers, and the mobile-payments rule bars it outright. Credit packs are
/// bought on the payer WEB portal, so this screen REPORTS what the server says
/// the payer has and has spent, and POINTS to the web for the purchase — the same
/// hand-off the Jobs screen uses for plans, boosts and quota top-ups.
class CreditsScreen extends StatelessWidget {
  const CreditsScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<CreditsScreenCubit>(
      create: (_) => locator<CreditsScreenCubit>()..load(),
      child: _CreditsView(onBack: onBack),
    );
  }
}

class _CreditsView extends StatelessWidget {
  const _CreditsView({required this.onBack});

  final VoidCallback onBack;

  /// Hands the payer to the WEB portal to buy credit packs. This REPLACED an
  /// in-app pack catalogue + Buy buttons that granted credits from inside the
  /// app — a store-barred payment surface. Falls back to an honest toast (no
  /// dead end, no fabricated link) when no usable web origin is configured or
  /// nothing on the device can open it.
  Future<void> _openCreditsOnWeb(BuildContext context) async {
    final String? base = resolvePayerWebUrl();
    bool opened = false;
    if (base != null) {
      final Uri? url = Uri.tryParse('$base/credits');
      if (url != null) {
        try {
          opened = await creditsExternalUrlLauncher(url);
        } catch (_) {
          opened = false;
        }
      }
    }
    if (opened || !context.mounted) return;
    showBbToast(
      context,
      title: 'Open on web',
      message: kBuyCreditsOnWebNote,
      icon: Icons.open_in_new,
    );
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CreditsScreenCubit, CreditsScreenState>(
      builder: (BuildContext context, CreditsScreenState state) {
        if (state.status == CreditsScreenStatus.loading ||
            state.status == CreditsScreenStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == CreditsScreenStatus.error) {
          final PayerFailure failure =
              state.failure ?? const PayerFailure(PayerFailureKind.unknown);
          return BbStatusView(
            icon: failure.icon,
            title: failure.title,
            subtitle: failure.message,
            action: BbButton(
              label: failure.isSessionExpired ? 'Log in' : 'Retry',
              onPressed: () => context.read<CreditsScreenCubit>().load(),
            ),
          );
        }

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Row(
              children: <Widget>[
                BbIconButton(
                  icon: Icons.arrow_back,
                  semanticLabel: 'Back',
                  onPressed: onBack,
                ),
                const SizedBox(width: AppSpacing.s3),
                // #376 — was 'Buy credits'. There is no pack, price, or checkout
                // element anywhere on this screen (the purchase lives on the web),
                // so that title promised a capability it does not have. The title
                // now names what the screen actually is.
                Text(
                  'Credits',
                  style: AppTypography.display(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            BbCard(
              ink: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    'Current balance',
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.ink300,
                    ),
                  ),
                  RichText(
                    text: TextSpan(
                      style: AppTypography.mono(
                        size: AppTypography.size2xl,
                        weight: FontWeight.w700,
                        color: AppColors.paper0,
                      ),
                      children: <InlineSpan>[
                        TextSpan(
                            text:
                                '${state.balance != null ? formatIndianGrouped(state.balance!) : '—'} '),
                        TextSpan(
                          text: 'unlocks',
                          style: AppTypography.body(
                            size: AppTypography.sizeBase,
                            color: AppColors.ink300,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            // #1200 — the in-app "Buy credits" pack catalogue + Buy buttons were
            // REMOVED (store IAP policy / mobile-payments rule). In their place, an
            // honest pointer to the web portal where the purchase actually happens,
            // mirroring the Jobs screen's plan/boost/top-up hand-off.
            const SizedBox(height: AppSpacing.s5),
            _BuyCreditsOnWeb(onOpen: () => _openCreditsOnWeb(context)),
            const SizedBox(height: AppSpacing.s5),
            // #376 follow-up — this section reads `GET /payer/credits/ledger`
            // (pack purchases, unlock debits, grants, refunds), so it is the
            // CREDIT ledger. The old 'Unlock ledger' heading mislabelled it; the
            // real per-unlock history is a separate section below.
            Text(
              'Credit ledger',
              style: AppTypography.display(
                size: AppTypography.sizeBase,
                weight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            if (state.ledger.isEmpty)
              _EmptyLedger(
                text: 'No credit activity yet.',
              )
            else
              BbCard(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
                child: Column(
                  children: <Widget>[
                    for (int i = 0; i < state.ledger.length; i++)
                      _LedgerRow(
                        entry: state.ledger[i],
                        showBorder: i < state.ledger.length - 1,
                      ),
                  ],
                ),
              ),
            // Per-unlock history (`GET /payer/unlocks`). Best-effort — only shown
            // when there is something to show, so a blip never leaves an empty
            // "Unlock history" card on screen.
            if (state.unlockLedger.isNotEmpty) ...<Widget>[
              const SizedBox(height: AppSpacing.s5),
              Text(
                'Unlock history',
                style: AppTypography.display(
                  size: AppTypography.sizeBase,
                  weight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: AppSpacing.s2),
              BbCard(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
                child: Column(
                  children: <Widget>[
                    for (int i = 0; i < state.unlockLedger.length; i++)
                      _LedgerRow(
                        entry: state.unlockLedger[i],
                        showBorder: i < state.unlockLedger.length - 1,
                      ),
                  ],
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

/// The external "buy credits on web" affordance + the one-line note that says out
/// loud why there is no in-app Buy button here. Mirrors the Jobs screen's
/// `_manageOnWeb` (secondary, block button + a muted note).
class _BuyCreditsOnWeb extends StatelessWidget {
  const _BuyCreditsOnWeb({required this.onOpen});

  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        BbButton(
          label: kBuyCreditsOnWebLabel,
          variant: BbButtonVariant.secondary,
          size: BbButtonSize.sm,
          iconLeft: Icons.open_in_new,
          block: true,
          onPressed: onOpen,
        ),
        const SizedBox(height: AppSpacing.s1),
        Text(
          kBuyCreditsOnWebNote,
          style: AppTypography.body(
            size: AppTypography.sizeXs,
            color: AppColors.textMuted,
          ),
        ),
      ],
    );
  }
}

/// A muted card shown in place of a ledger when there is nothing to list — an
/// honest empty state rather than a bare bordered card.
class _EmptyLedger extends StatelessWidget {
  const _EmptyLedger({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Text(
        text,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textMuted,
        ),
      ),
    );
  }
}

class _LedgerRow extends StatelessWidget {
  const _LedgerRow({required this.entry, required this.showBorder});

  final LedgerEntry entry;
  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    final Color amountColor = entry.direction == LedgerDirection.credit
        ? AppColors.success
        : AppColors.textMuted;
    return Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: <Widget>[
          Flexible(
            child: Text(
              entry.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
          ),
          Text(
            entry.amount,
            style: AppTypography.mono(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: amountColor,
            ),
          ),
        ],
      ),
    );
  }
}
