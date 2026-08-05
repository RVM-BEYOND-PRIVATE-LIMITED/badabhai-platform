import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/jobs_cubit.dart';

/// Edit an existing COMPANY posting (`PATCH /payer/job-postings/:id`).
///
/// Only the fields the company row carries back — role title, location, vacancy
/// band — are editable here. The `/payer/job-postings` projection exposes NO
/// description/org to READ, so those are deliberately NOT on this form: sending
/// them would clobber the server's current values with a blank. (Trade/pay/skills
/// were folded into `description` at post time — editing them needs the backend
/// to surface `description` on the row first.)
///
/// Pushed as a full page with its own back; drives the SHARED [JobsCubit] (so the
/// My-jobs list refetches) and pops on success.
class EditCompanyJobScreen extends StatefulWidget {
  const EditCompanyJobScreen({
    super.key,
    required this.job,
    required this.cubit,
  });

  final JobPosting job;
  final JobsCubit cubit;

  @override
  State<EditCompanyJobScreen> createState() => _EditCompanyJobScreenState();
}

class _EditCompanyJobScreenState extends State<EditCompanyJobScreen> {
  /// The server's `vacancy_band` enum — exact values the route accepts.
  static const List<String> _bands = <String>['1', '2-5', '6-10', '11-25', '25+'];

  late final TextEditingController _title =
      TextEditingController(text: widget.job.title);
  late final TextEditingController _location =
      TextEditingController(text: widget.job.locationLabel ?? '');
  late String _band =
      _bands.contains(widget.job.band) ? widget.job.band : _bands[1];
  bool _saving = false;

  @override
  void dispose() {
    _title.dispose();
    _location.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final String title = _title.text.trim();
    if (title.isEmpty) {
      showBbToast(
        context,
        title: 'Add the basics',
        message: 'A job title is needed.',
        icon: Icons.info_outline,
      );
      return;
    }

    setState(() => _saving = true);
    final String location = _location.text.trim();
    final JobActionResult result = await widget.cubit.editJob(
      widget.job.id!,
      roleTitle: title,
      // Empty → don't send (keeps the current value) rather than clear it to a
      // blank the route would 400.
      locationLabel: location.isEmpty ? null : location,
      vacancyBand: _band,
    );
    if (!mounted) return;
    showBbToast(
      context,
      title: result.success ? 'Saved' : 'Not now',
      message: result.message,
      icon: result.success ? Icons.check_circle : Icons.info_outline,
    );
    if (result.success) {
      Navigator.of(context).pop();
    } else {
      setState(() => _saving = false);
    }
  }

  /// A JUL31 section card — paper, 1px hairline, radius 10, elevation 0 — with a
  /// deep-blue Anek section title. Uses a [ListBody] (never a [Column]) as its
  /// vertical wrapper so a field label's only [Column] ancestor stays its own.
  Widget _sectionCard(String title, List<Widget> children) => BbCard(
        child: ListBody(
          children: <Widget>[
            Text(
              title,
              style: AppTypography.display(
                size: AppTypography.sizeMd,
                weight: FontWeight.w800,
                color: AppColors.blue,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            ...children,
          ],
        ),
      );

  /// A labelled single-select rendered as aligned kit chips — the JUL31 pattern
  /// for enum choices; selected flips to a solid haldi pill.
  Widget _chipField<T>({
    required String label,
    required T value,
    required List<T> options,
    required String Function(T) labelOf,
    required ValueChanged<T> onSelected,
  }) =>
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final T option in options)
                BbChip(
                  label: labelOf(option),
                  selected: option == value,
                  onTap: () => onSelected(option),
                ),
            ],
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
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
                  onPressed: () => Navigator.of(context).pop(),
                ),
                const SizedBox(width: AppSpacing.s3),
                Text(
                  'Edit job',
                  style: AppTypography.display(
                    size: AppTypography.sizeLg,
                    weight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            _sectionCard('Job details', <Widget>[
              BbField(label: 'Job title', controller: _title),
              const SizedBox(height: AppSpacing.s4),
              BbField(
                label: 'Location',
                controller: _location,
                hint: 'optional',
              ),
              const SizedBox(height: AppSpacing.s4),
              _chipField<String>(
                label: 'Vacancies',
                value: _band,
                options: _bands,
                labelOf: (String b) => b,
                onSelected: (String v) => setState(() => _band = v),
              ),
            ]),
            const SizedBox(height: AppSpacing.s4),
            Text(
              'Pay, experience and skills are part of the job description and are '
              'not editable here yet.',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
                height: 1.45,
              ),
            ),
            const SizedBox(height: AppSpacing.s5),
            BbButton(
              label: 'Save changes',
              iconLeft: Icons.check,
              block: true,
              loading: _saving,
              onPressed: _save,
            ),
          ],
        ),
      ),
    );
  }
}
