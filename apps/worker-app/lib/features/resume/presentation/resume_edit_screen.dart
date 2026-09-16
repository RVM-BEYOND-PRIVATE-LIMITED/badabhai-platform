import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/title_case.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toggle.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_docked_bar.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import 'cubit/resume_edit_cubit.dart';
import 'widgets/photo_picker_sheet.dart';
import '../domain/resume_safe_fields.dart';
import '../../../core/widgets/feedback_fab.dart';

/// Resume safe-field edit (`/resume/edit`). Full-screen; back returns to the
/// resume. The worker controls only this small set of fields — the rest of the
/// resume is owned by the extraction pipeline.
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
            ..showSnackBar(
              SnackBar(content: Text(failureReason(state.saveFailure).reason)),
            );
        }
      },
      builder: (BuildContext context, ResumeEditState state) {
        final ResumeEditCubit cubit = context.read<ResumeEditCubit>();
        final bool ready = state.status == ResumeEditStatus.ready;
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              // A PUSHED route, so it gets the back-arrow header rather than a
              // tab header. No brand badge: the worker is mid-task, not being
              // introduced to the app. It auto-collapses once the name
              // dialog's keyboard crowds a small screen.
              ShiftBlueHeader(
                title: 'Aap control karte hain',
                showBrandBadge: false,
                onBack: () => Navigator.of(context).maybePop(),
              ),
              Expanded(child: _body(context, cubit, state)),
            ],
          ),
          // Only the loaded screen has something to save. Publishes its height
          // to `bottomBarInset` so the floating Feedback pill (which still
          // shows on this pushed route) floats clear of the CTA.
          bottomNavigationBar: ready
              ? KitDockedBar(
                  child: BbButton(
                    label: 'Save karein',
                    block: true,
                    size: BbButtonSize.md,
                    iconLeft: Icons.check,
                    loading: state.saving,
                    onPressed: state.saving ? null : cubit.save,
                  ),
                )
              : null,
        );
      },
    );
  }

  Widget _body(
    BuildContext context,
    ResumeEditCubit cubit,
    ResumeEditState state,
  ) {
    return switch (state.status) {
      ResumeEditStatus.loading => const BbStatusView.loading(),
      ResumeEditStatus.failed => BbStatusView(
        icon: failureReason(state.failure).icon,
        title: 'Details load nahi hue.',
        subtitle: failureReason(state.failure).reason,
        action: FilledButton(
          onPressed: cubit.load,
          child: const Text('Try again'),
        ),
      ),
      ResumeEditStatus.ready => _ready(context, cubit, state, state.fields!),
    };
  }

  Widget _ready(
    BuildContext context,
    ResumeEditCubit cubit,
    ResumeEditState state,
    ResumeSafeFields fields,
  ) {
    final double width = MediaQuery.sizeOf(context).width;
    // A FORM, so it caps at 440 rather than the 600 tab lists use (R13).
    final EdgeInsets side = KitInsets.list(
      width,
      max: OnboardingLayout.maxContentWidth,
      gutter: 16,
    );
    return ListView(
      padding: EdgeInsets.fromLTRB(
        side.left,
        16,
        side.right,
        // Plus the floating Feedback pill's band, so it floats over empty
        // canvas rather than the last row. See [FeedbackFabInset].
        24 + FeedbackFabInset.of(context),
      ),
      children: <Widget>[
        Text(
          'Sirf yeh fields aap badal sakte hain. Baaki resume bada bhai '
          'sambhalta hai.',
          style: OnboardingTypography.bodyMuted(),
        ),
        const SizedBox(height: 16),
        // The editable safe fields grouped in one flat card — the card's
        // hairline border plus the inter-row hairlines carry separation, never
        // a shadow.
        KitCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: <Widget>[
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
        ),
      ],
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
    final String trimmed = titleCaseName(value.trim());
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
  late final TextEditingController _controller = TextEditingController(
    text: widget.initial,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      // SCROLLABLE, because this dialog opens WITH a keyboard: on a 320x568
      // handset at a 200% system font the keyboard leaves ~250dp, and the
      // title + field + actions need more than that — the dialog overflowed
      // its own box by 52px and the buttons went under the edge. Material
      // only wraps the title/content in a scroll view when asked.
      scrollable: true,
      title: Text(
        'Naam ki spelling',
        style: OnboardingTypography.anek(size: 18, weight: FontWeight.w800),
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

/// The name row: label + current spelling, with a pencil icon-button that opens
/// the edit dialog.
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
                Text('Naam ki spelling', style: _kRowLabelStyle),
                const SizedBox(height: 2),
                Text(value, style: _kRowValueStyle),
              ],
            ),
          ),
          const SizedBox(width: 12),
          IconButton(
            tooltip: 'Edit',
            onPressed: onEdit,
            iconSize: 22,
            color: OnboardingColors.shiftBlue,
            constraints: const BoxConstraints(
              minWidth: OnboardingLayout.tapTarget,
              minHeight: OnboardingLayout.tapTarget,
            ),
            icon: const Icon(Icons.edit_outlined),
          ),
        ],
      ),
    );
  }
}

/// The photo row (ADR-0032): a thumbnail (or add affordance) + a pencil that
/// opens the camera/gallery/remove sheet. The thumbnail loads from a SHORT-LIVED
/// signed url held in memory only; a load failure degrades to the placeholder
/// (never an error state — the photo is cosmetic here).
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
                Text('Aapki photo', style: _kRowLabelStyle),
                const SizedBox(height: 2),
                Text(
                  hasPhoto ? 'Photo lagi hai' : 'Photo add karein',
                  style: _kRowValueStyle,
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          _thumb(context),
          const SizedBox(width: 12),
          if (busy)
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: OnboardingColors.shiftBlue,
              ),
            )
          else
            IconButton(
              tooltip: hasPhoto ? 'Change photo' : 'Add photo',
              onPressed: onEdit,
              iconSize: 22,
              color: OnboardingColors.shiftBlue,
              constraints: const BoxConstraints(
                minWidth: OnboardingLayout.tapTarget,
                minHeight: OnboardingLayout.tapTarget,
              ),
              icon: Icon(
                hasPhoto ? Icons.edit_outlined : Icons.add_a_photo_outlined,
              ),
            ),
        ],
      ),
    );
  }

  Widget _thumb(BuildContext context) {
    final String? url = photoUrl;
    // Decode to the on-screen size, not the photo's full resolution.
    final int cachePx = (44 * MediaQuery.devicePixelRatioOf(context)).round();
    return CircleAvatar(
      radius: 22,
      backgroundColor: OnboardingColors.surfaceMuted,
      child: (hasPhoto && url != null)
          ? ClipOval(
              child: Image.network(
                url,
                width: 44,
                height: 44,
                cacheWidth: cachePx,
                cacheHeight: cachePx,
                fit: BoxFit.cover,
                // Signed url expired / offline → placeholder, never an error.
                errorBuilder: (_, __, ___) => const Icon(
                  Icons.person_outline,
                  size: 24,
                  color: OnboardingColors.ink500,
                ),
              ),
            )
          : const Icon(
              Icons.person_outline,
              size: 24,
              color: OnboardingColors.ink500,
            ),
    );
  }
}

/// A labelled toggle row.
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
          Expanded(child: Text(label, style: _kRowLabelStyle)),
          const SizedBox(width: 12),
          BbToggle(value: value, onChanged: onChanged, semanticLabel: label),
        ],
      ),
    );
  }
}

/// Shared row shell: padding + a hairline bottom divider (omitted on the last
/// row, where the card's own border closes the group).
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
            : const Border(
                bottom: BorderSide(color: OnboardingColors.borderSubtle),
              ),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: child,
    );
  }
}

final TextStyle _kRowLabelStyle = OnboardingTypography.inter(
  size: 14,
  weight: FontWeight.w600,
);
final TextStyle _kRowValueStyle = OnboardingTypography.inter(
  size: 13,
  color: OnboardingColors.ink600,
);
