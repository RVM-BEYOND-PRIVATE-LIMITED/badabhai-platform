import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/auth_api.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_spinner.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/devices_cubit.dart';

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
    // Kit auth chrome: full-bleed blue header over the list. Pushed from
    // Settings, so a white back affordance is shown. Not [BbScaffold] — the
    // header bleeds to the status bar.
    return Scaffold(
      body: Column(
        children: <Widget>[
          BbBlueHeader(
            title: 'Aapke devices',
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: SafeArea(
              top: false,
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
            DevicesStatus.ready => state.devices.isEmpty
                ? const BbStatusView(
                    icon: Icons.devices_other_rounded,
                    title: 'Koi doosra device nahi.',
                    subtitle: 'Sirf yeh phone is account mein logged-in hai.',
                  )
                : ListView.separated(
                    padding: const EdgeInsets.all(AppSpacing.gutter),
                    itemCount: state.devices.length,
                    separatorBuilder: (_, __) =>
                        const SizedBox(height: AppSpacing.s3),
                    itemBuilder: (BuildContext context, int i) => _DeviceTile(
                      device: state.devices[i],
                      revokingId: state.revokingId,
                    ),
                  ),
                  };
                },
              ),
            ),
          ),
        ],
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
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Row(
        children: <Widget>[
          // Soft square icon tile (kit list idiom). Blue = trust / this-is-you
          // for the current handset; a muted sunken tile for the rest.
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: device.isCurrent
                  ? AppColors.infoTint
                  : AppColors.surfaceSunken,
              borderRadius: BorderRadius.circular(AppRadii.sm),
            ),
            alignment: Alignment.center,
            child: Icon(
              device.isCurrent
                  ? Icons.phone_android_rounded
                  : Icons.devices_other_rounded,
              size: 20,
              color: device.isCurrent ? AppColors.blue : AppColors.textMuted,
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        label,
                        style: AppTypography.body(weight: FontWeight.w700),
                      ),
                    ),
                    if (device.isCurrent) ...<Widget>[
                      const SizedBox(width: AppSpacing.s2),
                      Text('· Yeh phone',
                          style: AppTypography.body(
                              size: AppTypography.sizeSm,
                              color: AppColors.success)),
                    ],
                  ],
                ),
                if (device.lastSeenAt != null)
                  Text(
                    'Aakhri baar: ${_ago(device.lastSeenAt!)}',
                    style: AppTypography.body(
                        size: AppTypography.sizeSm, color: AppColors.textMuted),
                  ),
              ],
            ),
          ),
          if (!device.isCurrent)
            isRevoking
                ? const Padding(
                    padding:
                        EdgeInsets.symmetric(horizontal: AppSpacing.s3),
                    child: BbSpinner(size: 24),
                  )
                : TextButton(
                    style: TextButton.styleFrom(
                        foregroundColor: AppColors.danger),
                    // Disabled while any revoke is in flight so a second tile
                    // cannot fire a duplicate revoke.
                    onPressed: revokeBlocked
                        ? null
                        : () => _confirmRevoke(context, device),
                    child: const Text('Hatayein'),
                  ),
        ],
      ),
    );
  }

  /// Derives a human label from platform + model (there is no server `label`).
  /// e.g. "Android · Pixel 6", or just "Android" when the model is unknown.
  static String _deviceLabel(AuthDevice device) {
    final String platform = device.platform.isEmpty
        ? 'Device'
        : '${device.platform[0].toUpperCase()}${device.platform.substring(1)}';
    final String? model = device.model;
    if (model == null || model.isEmpty) return platform;
    return '$platform · $model';
  }

  Future<void> _confirmRevoke(BuildContext context, AuthDevice device) async {
    final DevicesCubit cubit = context.read<DevicesCubit>();
    final String label = _deviceLabel(device);
    final bool ok = await showDialog<bool>(
          context: context,
          builder: (BuildContext d) => AlertDialog(
            title: const Text('Device hatayein?'),
            content: Text('$label se logout ho jayega.'),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(d).pop(false),
                child: const Text('Cancel'),
              ),
              TextButton(
                style: TextButton.styleFrom(foregroundColor: AppColors.danger),
                onPressed: () => Navigator.of(d).pop(true),
                child: const Text('Hatayein'),
              ),
            ],
          ),
        ) ??
        false;
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
