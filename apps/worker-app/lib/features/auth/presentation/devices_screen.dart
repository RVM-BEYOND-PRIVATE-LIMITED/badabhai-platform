import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/auth_api.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_alert_dialog.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_docked_bar.dart';
import '../../../core/widgets/kit/kit_pill.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import 'cubit/devices_cubit.dart';
import '../../../core/widgets/feedback_fab.dart';

/// The soft square icon tile shared by every device row (kit list idiom, the
/// same 40dp/8-radius tile `BbListRow` draws).
const double _kIconTile = 40;
const double _kIconTileRadius = 8;

/// My-devices: the worker's logged-in devices. The current one is marked; others
/// can be revoked (confirm dialog → revoke → reload). Reachable from Settings.
class DevicesScreen extends StatelessWidget {
  const DevicesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<DevicesCubit>(
      create: (_) => locator<DevicesCubit>()..load(),
      child: const _DevicesView(),
    );
  }
}

class _DevicesView extends StatelessWidget {
  const _DevicesView();

  @override
  Widget build(BuildContext context) {
    // Kit chrome (spec §2.1): the full-bleed navy header carries the status-bar
    // inset over a canvas body. Pushed from Settings, so a back affordance is
    // shown. Not [BbScaffold] — the header bleeds to the status bar.
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: 'Aapke devices',
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              bottom: false,
              child: BlocBuilder<DevicesCubit, DevicesState>(
                builder: (BuildContext context, DevicesState state) {
                  return switch (state.status) {
                    DevicesStatus.loading => const BbStatusView.loading(),
                    DevicesStatus.failed => BbStatusView(
                      icon: Icons.error_outline_rounded,
                      title: 'Devices load nahi hue.',
                      // DevicesCubit surfaces an AuthFailure as a localized reason in
                      // state.message (via authErrorMessage) — show that honest cause,
                      // not a false "check internet".
                      subtitle: state.message ?? 'Dobara try karein.',
                      action: FilledButton(
                        onPressed: () => context.read<DevicesCubit>().load(),
                        child: const Text('Try again'),
                      ),
                    ),
                    // Empty ≠ failed: a valid 2xx with no other devices shows an honest
                    // "only this phone" note, NOT a blank list — and never the failed
                    // view's parse/unauthorized reason. (A shape drift now throws
                    // contractError upstream, so it lands in DevicesStatus.failed.)
                    DevicesStatus.ready =>
                      state.devices.isEmpty
                          ? const BbStatusView(
                              icon: Icons.devices_other_rounded,
                              title: 'Koi doosra device nahi.',
                              subtitle:
                                  'Sirf yeh phone is account mein logged-in hai.',
                            )
                          : _list(context, state),
                  };
                },
              ),
            ),
          ),
          // The lost/stolen-handset panic button. OUTSIDE the list BlocBuilder so
          // it stays reachable even if the list failed to load — a worker whose
          // phone was stolen must be able to sign every device out regardless.
          const _LogoutAllBar(),
        ],
      ),
    );
  }

  /// The device cards. The scroll view owns its horizontal padding (D7), so the
  /// column centres on a tablet while the scrollbar stays at the screen edge.
  Widget _list(BuildContext context, DevicesState state) {
    final double width = MediaQuery.sizeOf(context).width;
    return ListView.separated(
      padding: KitInsets.list(
        width,
        max: OnboardingLayout.maxContentWidth,
        gutter: 16,
      ).copyWith(
        top: 16,
        // Plus the floating Feedback pill's band. See [FeedbackFabInset].
        bottom: 16 + FeedbackFabInset.of(context),
      ),
      itemCount: state.devices.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (BuildContext context, int i) =>
          _DeviceTile(device: state.devices[i], revokingId: state.revokingId),
    );
  }
}

/// "Sign out of ALL devices" (ADR-0034 panic button). A non-dismissible confirm,
/// then [DevicesCubit.logoutAll] → the server revokes every session (this device
/// included) and the app hard-logs-out to phone login, so the router tears this
/// screen down; the local busy flag only matters if no manager is wired.
class _LogoutAllBar extends StatefulWidget {
  const _LogoutAllBar();

  @override
  State<_LogoutAllBar> createState() => _LogoutAllBarState();
}

class _LogoutAllBarState extends State<_LogoutAllBar> {
  bool _busy = false;

  Future<void> _confirm() async {
    final DevicesCubit cubit = context.read<DevicesCubit>();
    final bool ok = await showBbConfirm(
      context,
      title: 'Sabhi devices se logout?',
      message:
          'Aap sabhi phone aur devices se — yeh phone bhi — logout ho '
          'jaayenge. Dobara use karne ke liye phir se login karna hoga.',
      confirmLabel: 'Logout karein',
      destructive: true,
      // A worker signing every device out of their account must read this, not
      // tap past it: the barrier does not dismiss it.
      barrierDismissible: false,
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    await cubit.logoutAll();
    // Reached only when the sign-out did NOT tear the screen down (e.g. no auth
    // manager wired in a test/plugin-free graph) — the router redirect handles
    // the real app.
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    // The kit's docked bar (D4): white, top hairline, safe-area padded — and it
    // publishes its own height to `bottomBarInset`, so the app-wide Feedback
    // pill floats clear of this button instead of sitting on it.
    return KitDockedBar(
      maxWidth: OnboardingLayout.maxContentWidth,
      child: BbButton(
        label: 'Sabhi devices se logout',
        // The longest CTA label in the app: it wraps rather than truncating,
        // because 'Sabhi devices se log…' does not say what the button does.
        allowMultilineLabel: true,
        variant: BbButtonVariant.danger,
        size: BbButtonSize.md,
        block: true,
        loading: _busy,
        iconLeft: Icons.logout_rounded,
        onPressed: _busy ? null : _confirm,
      ),
    );
  }
}

class _DeviceTile extends StatelessWidget {
  const _DeviceTile({required this.device, this.revokingId});

  final AuthDevice device;

  /// Id of the device whose revoke is in flight (from DevicesState). When it
  /// matches this device the action shows a spinner; when any revoke is in
  /// flight every tile's action is disabled to block duplicate taps.
  final String? revokingId;

  @override
  Widget build(BuildContext context) {
    final String label = _deviceLabel(device);
    final bool isRevoking = revokingId == device.id;
    final bool revokeBlocked = revokingId != null;
    return KitCard(
      child: Row(
        children: <Widget>[
          // Blue = trust / this-is-you for the current handset; a muted tile for
          // the rest.
          Container(
            width: _kIconTile,
            height: _kIconTile,
            decoration: BoxDecoration(
              color: device.isCurrent
                  ? OnboardingColors.infoBg
                  : OnboardingColors.pillMutedBg,
              borderRadius: BorderRadius.circular(_kIconTileRadius),
            ),
            alignment: Alignment.center,
            child: Icon(
              device.isCurrent
                  ? Icons.smartphone_rounded
                  : Icons.devices_other_rounded,
              size: 20,
              color: device.isCurrent
                  ? OnboardingColors.shiftBlue
                  : OnboardingColors.ink500,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                // A Wrap, not a Row: at a large system font the label and the
                // 'Yeh phone' pill no longer fit on one line, and the pill drops
                // under the label instead of squeezing it to an ellipsis.
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: <Widget>[
                    Text(
                      label,
                      style: OnboardingTypography.inter(
                        size: 14,
                        weight: FontWeight.w700,
                      ),
                    ),
                    if (device.isCurrent)
                      const KitPill(
                        label: 'Yeh phone',
                        tone: KitPillTone.green,
                      ),
                  ],
                ),
                if (device.lastSeenAt != null) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    'Aakhri baar: ${_ago(device.lastSeenAt!)}',
                    style: OnboardingTypography.bodyMuted(),
                  ),
                ],
              ],
            ),
          ),
          // The revoke action is a COMPACT CONTROL, not body copy, so it
          // clamps its own text scaling like the rest of the chrome. Unclamped
          // at a 2.0 system font 'Hatayein' plus its padding was wider than the
          // whole card minus the icon tile, which starved the `Expanded`
          // beside it and painted an overflow stripe across the tile — on the
          // one screen a worker uses to kick a stolen phone off their account.
          if (!device.isCurrent)
            MediaQuery.withClampedTextScaling(
              maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
              child: isRevoking
                ? const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 12),
                    child: SizedBox(
                      width: 24,
                      height: 24,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: OnboardingColors.shiftBlue,
                      ),
                    ),
                  )
                : TextButton(
                    style: TextButton.styleFrom(
                      foregroundColor: OnboardingColors.errorRed,
                      textStyle: OnboardingTypography.inter(
                        size: 13,
                        weight: FontWeight.w700,
                        color: OnboardingColors.errorRed,
                      ),
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      minimumSize: const Size(
                        OnboardingLayout.tapTarget,
                        OnboardingLayout.tapTarget,
                      ),
                      tapTargetSize: MaterialTapTargetSize.padded,
                    ),
                    // Disabled while any revoke is in flight so a second tile
                    // cannot fire a duplicate revoke.
                    onPressed: revokeBlocked
                        ? null
                        : () => _confirmRevoke(context, device),
                    child: const Text('Hatayein'),
                  ),
            ),
        ],
      ),
    );
  }

  /// Derives a human label from platform + model (there is no server `label`,
  /// B16). e.g. "Android · Pixel 6", or just "Android" when the model is unknown.
  ///
  /// The platform is a raw wire token, so it is HUMANIZED here rather than
  /// title-cased blindly: `ios` used to render as "Ios", which is not the name
  /// of any phone a worker owns. An unknown platform still title-cases (better
  /// than hiding a real device), and an empty one becomes "Device".
  static String _deviceLabel(AuthDevice device) {
    final String raw = device.platform.trim();
    final String platform = switch (raw.toLowerCase()) {
      '' => 'Device',
      'ios' => 'iPhone',
      'ipados' => 'iPad',
      'android' => 'Android',
      _ => '${raw[0].toUpperCase()}${raw.substring(1)}',
    };
    final String? model = device.model;
    if (model == null || model.trim().isEmpty) return platform;
    return '$platform · ${model.trim()}';
  }

  Future<void> _confirmRevoke(BuildContext context, AuthDevice device) async {
    final DevicesCubit cubit = context.read<DevicesCubit>();
    final String label = _deviceLabel(device);
    final bool ok = await showBbConfirm(
      context,
      title: 'Device hatayein?',
      message: '$label se logout ho jayega.',
      confirmLabel: 'Hatayein',
      cancelLabel: 'Cancel',
      destructive: true,
    );
    if (ok) await cubit.revoke(device.id);
  }

  String _ago(DateTime when) {
    final Duration d = DateTime.now().difference(when);
    if (d.inDays >= 1) return '${d.inDays} din pehle';
    if (d.inHours >= 1) return '${d.inHours} ghante pehle';
    if (d.inMinutes >= 1) return '${d.inMinutes} min pehle';
    return 'abhi';
  }
}
