import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/auth/auth_api.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_scaffold.dart';
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
    return BbScaffold(
      padded: false,
      appBar: const BbAppBar(title: 'Aapke devices'),
      body: BlocBuilder<DevicesCubit, DevicesState>(
        builder: (BuildContext context, DevicesState state) {
          return switch (state.status) {
            DevicesStatus.loading => const BbStatusView.loading(),
            DevicesStatus.failed => BbStatusView(
                icon: Icons.cloud_off_rounded,
                title: 'Devices load nahi hue.',
                subtitle: 'Internet check karke dobara try karein.',
                action: FilledButton(
                  onPressed: () => context.read<DevicesCubit>().load(),
                  child: const Text('Try again'),
                ),
              ),
            DevicesStatus.ready => ListView.separated(
                padding: const EdgeInsets.all(AppSpacing.gutter),
                itemCount: state.devices.length,
                separatorBuilder: (_, __) =>
                    const SizedBox(height: AppSpacing.s3),
                itemBuilder: (BuildContext context, int i) =>
                    _DeviceTile(device: state.devices[i]),
              ),
          };
        },
      ),
    );
  }
}

class _DeviceTile extends StatelessWidget {
  const _DeviceTile({required this.device});

  final AuthDevice device;

  @override
  Widget build(BuildContext context) {
    final String label = _deviceLabel(device);
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Row(
        children: <Widget>[
          Icon(
            device.isCurrent
                ? Icons.phone_android_rounded
                : Icons.devices_other_rounded,
            color: device.isCurrent ? AppColors.brand : AppColors.textMuted,
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
            TextButton(
              style:
                  TextButton.styleFrom(foregroundColor: AppColors.danger),
              onPressed: () => _confirmRevoke(context, device),
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
