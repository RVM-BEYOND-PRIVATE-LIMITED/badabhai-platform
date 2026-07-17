import 'dart:async';
import 'dart:typed_data';

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
import 'widgets/photo_picker_sheet.dart';
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
          // Hand the preview the one fact it needs: did the NAME change? The
          // name is baked in at generation time, so the preview must regenerate
          // to show the new spelling (and to name the downloaded PDF with it,
          // #398). Popping bare `null` is why an edited name never appeared.
          context.pop(state.nameChanged);
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
          _PhotoField(
            hasPhoto: fields.hasPhoto,
            photoUrl: state.photoUrl,
            busy: state.photoBusy,
            onEdit: () => _editPhoto(context, cubit, fields.hasPhoto),
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
    final String? value = await showDialog<String>(
      context: context,
      builder: (_) => _NameDialog(initial: current),
    );
    if (!mounted) return; // popped while the dialog was open
    if (value == null) return;
    final String trimmed = value.trim();
    if (trimmed.isEmpty) return;
    cubit.setDisplayName(trimmed);
  }

  /// ADR-0032 — the shared photo flow (sheet → pick → resize on-device), with
  /// this screen's cubit doing the upload/remove so its busy state + error
  /// surfacing are unchanged. The flow itself lives in ONE place
  /// ([runPhotoFlow]) and is shared with the Profile tab — there is one photo per
  /// worker, so there is one way to change it.
  Future<void> _editPhoto(
    BuildContext context,
    ResumeEditCubit cubit,
    bool hasPhoto,
  ) {
    return runPhotoFlow(
      context,
      hasPhoto: hasPhoto,
      onUpload: (Uint8List bytes) => unawaited(cubit.uploadPhoto(bytes)),
      onRemove: () => unawaited(cubit.removePhoto()),
    );
  }
}

/// The name-spelling dialog. It OWNS its [TextEditingController] so the
/// controller's lifetime is tied to this widget rather than to the awaiting
/// caller: `showDialog`'s future completes the instant the route is popped —
/// while the route is still mounted and animating out — so disposing it from the
/// caller would tear the controller out from under a live [TextField] ("A
/// TextEditingController was used after being disposed").
class _NameDialog extends StatefulWidget {
  const _NameDialog({required this.initial});

  final String initial;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(
        'Naam ki spelling',
        style: AppTypography.display(size: AppTypography.sizeLg),
      ),
      content: TextField(
        controller: _controller,
        autofocus: true,
        textCapitalization: TextCapitalization.words,
        decoration: const InputDecoration(hintText: 'Naam'),
        onSubmitted: (String v) => Navigator.of(context).pop(v),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(_controller.text),
          child: const Text('OK'),
        ),
      ],
    );
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

/// `.aw-field` — the photo row (ADR-0032): a thumbnail (or add affordance) +
/// a pencil that opens the camera/gallery/remove sheet. The thumbnail loads
/// from a SHORT-LIVED signed url held in memory only; a load failure degrades
/// to the placeholder (never an error state — the photo is cosmetic here).
class _PhotoField extends StatelessWidget {
  const _PhotoField({
    required this.hasPhoto,
    required this.photoUrl,
    required this.busy,
    required this.onEdit,
  });

  final bool hasPhoto;
  final String? photoUrl;
  final bool busy;
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
                  'Aapki photo',
                  style: AppTypography.body(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: AppSpacing.s1 / 2),
                Text(
                  hasPhoto ? 'Photo lagi hai' : 'Photo add karein',
                  style: AppTypography.body(color: AppColors.textMuted),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s3),
          _thumb(),
          const SizedBox(width: AppSpacing.s3),
          if (busy)
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            IconButton(
              tooltip: hasPhoto ? 'Change photo' : 'Add photo',
              onPressed: onEdit,
              iconSize: 22,
              constraints: const BoxConstraints(
                minWidth: AppSpacing.tap,
                minHeight: AppSpacing.tap,
              ),
              icon: Icon(
                hasPhoto ? Icons.edit_outlined : Icons.add_a_photo_outlined,
              ),
            ),
        ],
      ),
    );
  }

  Widget _thumb() {
    final String? url = photoUrl;
    return CircleAvatar(
      radius: 22,
      backgroundColor: AppColors.divider,
      child: (hasPhoto && url != null)
          ? ClipOval(
              child: Image.network(
                url,
                width: 44,
                height: 44,
                fit: BoxFit.cover,
                // Signed url expired / offline → placeholder, never an error.
                errorBuilder: (_, __, ___) =>
                    const Icon(Icons.person_outline, size: 24),
              ),
            )
          : const Icon(Icons.person_outline, size: 24),
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
