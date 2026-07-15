import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/reveal_cubit.dart';

/// The caller's OWN masked-résumé disclosure history
/// (`GET /payer/resume-disclosures`, newest-first). PII-FREE: an opaque worker
/// UUID (masked here), a status pill, and disclosed/expiry timestamps — never a
/// name or phone. A load failure surfaces its real reason (never a silent empty
/// list).
class DisclosureHistoryScreen extends StatelessWidget {
  const DisclosureHistoryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<RevealCubit>(
      create: (_) => locator<RevealCubit>()..loadDisclosures(),
      child: const _DisclosureHistoryView(),
    );
  }
}

class _DisclosureHistoryView extends StatelessWidget {
  const _DisclosureHistoryView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _Header(onBack: () => Navigator.of(context).pop()),
            Expanded(
              child: BlocBuilder<RevealCubit, RevealState>(
                buildWhen: (RevealState a, RevealState b) =>
                    a.historyStatus != b.historyStatus ||
                    a.disclosures != b.disclosures,
                builder: (BuildContext context, RevealState state) =>
                    _body(context, state),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, RevealState state) {
    switch (state.historyStatus) {
      case DisclosureHistoryStatus.idle:
      case DisclosureHistoryStatus.loading:
        return const BbStatusView.loading(caption: 'Loading history…');
      case DisclosureHistoryStatus.error:
        return BbStatusView(
          icon: Icons.wifi_off,
          title: 'Could not load history',
          subtitle: 'Please check your connection and try again.',
          action: BbButton(
            label: 'Retry',
            onPressed: () => context.read<RevealCubit>().loadDisclosures(),
          ),
        );
      case DisclosureHistoryStatus.ready:
        if (state.disclosures.isEmpty) {
          return const BbStatusView(
            icon: Icons.folder_open_outlined,
            title: 'No disclosures yet',
            subtitle:
                'Résumés you disclose from a candidate will appear here.',
          );
        }
        return ListView.separated(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          itemCount: state.disclosures.length,
          separatorBuilder: (_, __) => const SizedBox(height: AppSpacing.s3),
          itemBuilder: (BuildContext context, int i) =>
              _DisclosureRow(state.disclosures[i]),
        );
    }
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          BbIconButton(
            icon: Icons.arrow_back,
            semanticLabel: 'Back',
            onPressed: onBack,
          ),
          const SizedBox(width: AppSpacing.s3),
          Text(
            'Disclosure history',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

/// One disclosure row — PII-free. The worker id is opaque and shown masked; a
/// null id (DSAR hard-delete SET NULL) renders as "removed".
class _DisclosureRow extends StatelessWidget {
  const _DisclosureRow(this.row);

  final PayerDisclosure row;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  'Worker ${_maskId(row.workerId)}',
                  style: AppTypography.body(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w700,
                  ),
                ),
              ),
              BbBadge(_statusLabel(row.status), tone: _statusTone(row.status)),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          _MetaLine(label: 'Disclosed', value: _fmtDate(row.disclosedAt)),
          if (row.expiresAt != null)
            _MetaLine(label: 'Expires', value: _fmtDate(row.expiresAt)),
        ],
      ),
    );
  }

  /// Show only the last 4 chars of the opaque UUID — enough to disambiguate,
  /// never the full id. Null → the worker was hard-deleted (DSAR).
  static String _maskId(String? id) {
    if (id == null || id.isEmpty) return 'removed';
    return id.length <= 4 ? '••$id' : '••${id.substring(id.length - 4)}';
  }

  static String _statusLabel(String status) => switch (status) {
        'disclosed' => 'Disclosed',
        'expired' => 'Expired',
        'revoked' => 'Revoked',
        'unavailable' => 'Unavailable',
        _ => status,
      };

  static BbBadgeTone _statusTone(String status) => switch (status) {
        'disclosed' => BbBadgeTone.success,
        'expired' => BbBadgeTone.neutral,
        'revoked' || 'unavailable' => BbBadgeTone.danger,
        _ => BbBadgeTone.neutral,
      };

  /// ISO-8601 → "dd MMM yyyy" without the intl package. Falls back to the raw
  /// string if it doesn't parse.
  static String _fmtDate(String? iso) {
    if (iso == null || iso.isEmpty) return '—';
    final DateTime? dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return iso;
    const List<String> m = <String>[
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    final String dd = dt.day.toString().padLeft(2, '0');
    return '$dd ${m[dt.month - 1]} ${dt.year}';
  }
}

class _MetaLine extends StatelessWidget {
  const _MetaLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        children: <Widget>[
          Text('$label: ',
              style: AppTypography.body(color: AppColors.textMuted)),
          Text(value,
              style: AppTypography.body(
                  color: AppColors.textSecondary, weight: FontWeight.w600)),
        ],
      ),
    );
  }
}
