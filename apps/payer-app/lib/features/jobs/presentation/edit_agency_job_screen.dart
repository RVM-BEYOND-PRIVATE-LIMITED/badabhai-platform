import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/agency_jobs_cubit.dart';

/// Edit an existing AGENCY posting (`PATCH /payer/agency/jobs/:id`). The
/// [AgencyJobView] carries every field typed, so the form is fully prefilled and
/// every attribute is editable — trade / title / city / area / pay & experience
/// bands / timing. Mirrors the agency branch of Post-a-job.
///
/// Pushed as a full page with its own back; on save it drives the SHARED
/// [AgencyJobsCubit] (so the My-jobs list refetches) and pops on success.
class EditAgencyJobScreen extends StatefulWidget {
  const EditAgencyJobScreen({
    super.key,
    required this.job,
    required this.cubit,
  });

  final AgencyJobView job;
  final AgencyJobsCubit cubit;

  @override
  State<EditAgencyJobScreen> createState() => _EditAgencyJobScreenState();
}

class _EditAgencyJobScreenState extends State<EditAgencyJobScreen> {
  late final TextEditingController _title =
      TextEditingController(text: widget.job.title);
  late final TextEditingController _city =
      TextEditingController(text: widget.job.city);
  late final TextEditingController _area =
      TextEditingController(text: widget.job.area ?? '');
  late final TextEditingController _payMin =
      TextEditingController(text: widget.job.payMin?.toString() ?? '');
  late final TextEditingController _payMax =
      TextEditingController(text: widget.job.payMax?.toString() ?? '');
  late final TextEditingController _expMin =
      TextEditingController(text: widget.job.minExperienceYears?.toString() ?? '');
  late final TextEditingController _expMax =
      TextEditingController(text: widget.job.maxExperienceYears?.toString() ?? '');

  late String _tradeKey = kAgencyTradeKeys.contains(widget.job.tradeKey)
      ? widget.job.tradeKey
      : kAgencyTradeKeys.first;
  late String _neededBy = kAgencyNeededBy.contains(widget.job.neededBy)
      ? widget.job.neededBy!
      : kAgencyNeededBy.first;
  bool _saving = false;

  @override
  void dispose() {
    _title.dispose();
    _city.dispose();
    _area.dispose();
    _payMin.dispose();
    _payMax.dispose();
    _expMin.dispose();
    _expMax.dispose();
    super.dispose();
  }

  static int? _intOrNull(String raw) {
    final String t = raw.trim();
    if (t.isEmpty) return null;
    return int.tryParse(t);
  }

  Future<void> _save() async {
    final String title = _title.text.trim();
    final String city = _city.text.trim();
    if (title.isEmpty || city.isEmpty) {
      showBbToast(
        context,
        title: 'Add the basics',
        message: 'Job title and city are needed.',
        icon: Icons.info_outline,
      );
      return;
    }

    final int? payMin = _intOrNull(_payMin.text);
    final int? payMax = _intOrNull(_payMax.text);
    final int? expMin = _intOrNull(_expMin.text);
    final int? expMax = _intOrNull(_expMax.text);
    if (payMin != null && payMax != null && payMax < payMin) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: 'Max pay must be at least the min.',
        icon: Icons.info_outline,
      );
      return;
    }
    if (expMin != null && expMax != null && expMax < expMin) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: 'Max experience must be at least the min.',
        icon: Icons.info_outline,
      );
      return;
    }

    setState(() => _saving = true);
    final String area = _area.text.trim();
    final JobActionResult result = await widget.cubit.editJob(
      widget.job.id,
      tradeKey: _tradeKey,
      title: title,
      city: city,
      area: area.isEmpty ? null : area,
      payMin: payMin,
      payMax: payMax,
      minExperienceYears: expMin,
      maxExperienceYears: expMax,
      neededBy: _neededBy,
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
            BbSelect<String>(
              label: 'Trade',
              value: _tradeKey,
              items: kAgencyTradeKeys,
              labelOf: agencyTradeLabel,
              onChanged: (String? v) => setState(() => _tradeKey = v ?? _tradeKey),
            ),
            const SizedBox(height: AppSpacing.s4),
            BbField(label: 'Job title', controller: _title),
            const SizedBox(height: AppSpacing.s4),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: BbField(label: 'City', controller: _city),
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: BbField(label: 'Area (optional)', controller: _area),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: BbField(
                    label: 'Pay min ₹/mo',
                    controller: _payMin,
                    hint: 'optional',
                    keyboardType: TextInputType.number,
                    mono: true,
                  ),
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: BbField(
                    label: 'Pay max ₹/mo',
                    controller: _payMax,
                    hint: 'optional',
                    keyboardType: TextInputType.number,
                    mono: true,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: BbField(
                    label: 'Exp min (yrs)',
                    controller: _expMin,
                    hint: 'optional',
                    keyboardType: TextInputType.number,
                    mono: true,
                  ),
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: BbField(
                    label: 'Exp max (yrs)',
                    controller: _expMax,
                    hint: 'optional',
                    keyboardType: TextInputType.number,
                    mono: true,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s4),
            BbSelect<String>(
              label: 'Needed by',
              value: _neededBy,
              items: kAgencyNeededBy,
              labelOf: agencyNeededByLabel,
              onChanged: (String? v) => setState(() => _neededBy = v ?? _neededBy),
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
