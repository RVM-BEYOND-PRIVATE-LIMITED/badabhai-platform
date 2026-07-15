import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toggle.dart';
import 'cubit/resume_edit_cubit.dart';
import '../domain/resume_safe_fields.dart';

/// Resume safe-field edit (spec §5.2 / `.aw-field`). Full-screen; back returns
/// to the resume. The worker controls only this small set of fields — the rest
/// of the resume is owned by the extraction pipeline.
class ResumeEditScreen extends StatelessWidget {
  const ResumeEditScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ResumeEditCubit>(
      create: (_) => locator<ResumeEditCubit>()..load(),
      child: const _ResumeEditView(),
    );
  }
}

class _ResumeEditView extends StatefulWidget {
  const _ResumeEditView();

  @override
  State<_ResumeEditView> createState() => _ResumeEditViewState();
}

class _ResumeEditViewState extends State<_ResumeEditView> {
  int _shownSaved = 0;
  int _shownError = 0;

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ResumeEditCubit, ResumeEditState>(
      listenWhen: (ResumeEditState p, ResumeEditState c) =>
          p.savedNonce != c.savedNonce || p.saveErrorNonce != c.saveErrorNonce,
      listener: (BuildContext context, ResumeEditState state) {
        if (state.savedNonce != _shownSaved) {
          _shownSaved = state.savedNonce;
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(const SnackBar(content: Text('Saved')));
          context.pop();
        } else if (state.saveErrorNonce != _shownError) {
          // A save failed — surface the honest reason and stay on the screen so
          // the worker can fix it and retry (mirrors the load-failed path).
          _shownError = state.saveErrorNonce;
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(SnackBar(
              content: Text(failureReason(state.saveFailure).reason),
            ));
        }
      },
      builder: (BuildContext context, ResumeEditState state) {
        final ResumeEditCubit cubit = context.read<ResumeEditCubit>();
        return switch (state.status) {
          ResumeEditStatus.loading => const BbScaffold(
              appBar: BbAppBar(title: 'Aap control karte hain'),
              body: BbStatusView.loading(),
            ),
          ResumeEditStatus.failed => BbScaffold(
              appBar: const BbAppBar(title: 'Aap control karte hain'),
              body: BbStatusView(
                icon: failureReason(state.failure).icon,
                title: 'Details load nahi hue.',
                subtitle: failureReason(state.failure).reason,
                action: FilledButton(
                  onPressed: cubit.load,
                  child: const Text('Try again'),
                ),
              ),
            ),
          ResumeEditStatus.ready =>
            _ready(context, cubit, state, state.fields!),
        };
      },
    );
  }

  Widget _ready(
    BuildContext context,
    ResumeEditCubit cubit,
    ResumeEditState state,
    ResumeSafeFields fields,
  ) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Aap control karte hain'),
      bottomBar: BbButton(
        label: 'Save karein',
        block: true,
        iconLeft: Icons.check,
        loading: state.saving,
        onPressed: state.saving ? null : cubit.save,
      ),
      body: ListView(
        padding: const EdgeInsets.only(top: AppSpacing.s4),
        children: <Widget>[
          Text(
            'Sirf yeh fields aap badal sakte hain. Baaki resume bada bhai '
            'sambhalta hai.',
            style: AppTypography.body(color: AppColors.textMuted),
          ),
          const SizedBox(height: AppSpacing.s4),
          _NameField(
            value: fields.displayName,
            onEdit: () => _editName(context, cubit, fields.displayName),
          ),
          _ToggleField(
            label: 'Photo dikhayein',
            value: fields.showPhoto,
            onChanged: cubit.setShowPhoto,
          ),
          _ToggleField(
            label: 'Night shift ke liye taiyaar',
            value: fields.nightShiftReady,
            onChanged: cubit.setNightShiftReady,
            last: true,
          ),
        ],
      ),
    );
  }

  Future<void> _editName(
    BuildContext context,
    ResumeEditCubit cubit,
    String current,
  ) async {
    final TextEditingController controller =
        TextEditingController(text: current);
    final String? value = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(
            'Naam ki spelling',
            style: AppTypography.display(size: AppTypography.sizeLg),
          ),
          content: TextField(
            controller: controller,
            autofocus: true,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(hintText: 'Naam'),
            onSubmitted: (String v) => Navigator.of(dialogContext).pop(v),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () =>
                  Navigator.of(dialogContext).pop(controller.text),
              child: const Text('OK'),
            ),
          ],
        );
      },
    );
    controller.dispose();
    if (value == null) return;
    final String trimmed = value.trim();
    if (trimmed.isEmpty) return;
    cubit.setDisplayName(trimmed);
  }
}

/// `.aw-field` — the name row: label + current spelling subtitle, with a pencil
/// icon-button that opens the edit dialog.
class _NameField extends StatelessWidget {
  const _NameField({required this.value, required this.onEdit});

  final String value;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    return _FieldRow(
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'Naam ki spelling',
                  style: AppTypography.body(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: AppSpacing.s1 / 2),
                Text(
                  value,
                  style: AppTypography.body(color: AppColors.textMuted),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          IconButton(
            tooltip: 'Edit',
            onPressed: onEdit,
            iconSize: 22,
            constraints: const BoxConstraints(
              minWidth: AppSpacing.tap,
              minHeight: AppSpacing.tap,
            ),
            icon: const Icon(Icons.edit_outlined),
          ),
        ],
      ),
    );
  }
}

/// `.aw-field` — a labelled toggle row.
class _ToggleField extends StatelessWidget {
  const _ToggleField({
    required this.label,
    required this.value,
    required this.onChanged,
    this.last = false,
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return _FieldRow(
      last: last,
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              label,
              style: AppTypography.body(
                size: AppTypography.sizeMd,
                weight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          BbToggle(value: value, onChanged: onChanged),
        ],
      ),
    );
  }
}

/// Shared `.aw-field` shell: vertical padding + a hairline bottom divider
/// (omitted on the last row).
class _FieldRow extends StatelessWidget {
  const _FieldRow({required this.child, this.last = false});

  final Widget child;
  final bool last;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: last
            ? null
            : const Border(bottom: BorderSide(color: AppColors.divider)),
      ),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: child,
    );
  }
}
