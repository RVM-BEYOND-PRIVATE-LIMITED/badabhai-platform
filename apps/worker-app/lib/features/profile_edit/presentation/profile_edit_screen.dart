import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/api/api_client.dart'
    show
        CertificateEntryDto,
        LanguageAbilityDto,
        PortfolioItemDto,
        TrainingEntryDto;
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/taxonomy_labels.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_select_chip.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../domain/profile_edit_models.dart';
import 'cubit/profile_edit_cubit.dart';

/// The Layer A profile edit surface (ADR-0042 D9, issue #1545).
///
/// One pushed screen with one independently-saveable card per surface: WhatsApp,
/// richer languages (speak/read/write), the extended work attributes, trainings
/// and licence fields, the portfolio, and secondary occupations. Every card
/// writes its own endpoint, so a slow portfolio upload never blocks a WhatsApp
/// edit and a failure in one card never rolls back another.
///
/// PRIVACY: the WhatsApp number and the licence number/expiry are worker-self
/// only. The header and cards say so in copy; the values are never logged.
class ProfileEditScreen extends StatelessWidget {
  const ProfileEditScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ProfileEditCubit>(
      create: (_) => locator<ProfileEditCubit>()..load(),
      child: const _ProfileEditView(),
    );
  }
}

class _ProfileEditView extends StatelessWidget {
  const _ProfileEditView();

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<ProfileEditCubit, ProfileEditState>(
      listenWhen: (ProfileEditState p, ProfileEditState c) =>
          (c.error != null && c.error != p.error) ||
          (c.notice != null && c.notice != p.notice),
      listener: (BuildContext context, ProfileEditState state) {
        final String? message = state.error ?? state.notice;
        if (message == null) return;
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(message)));
        context.read<ProfileEditCubit>().clearFeedback();
      },
      builder: (BuildContext context, ProfileEditState state) {
        return Scaffold(
          backgroundColor: OnboardingColors.canvasBg,
          body: Column(
            children: <Widget>[
              ShiftBlueHeader(
                title: 'Profile edit',
                compact: true,
                maxWidth: OnboardingLayout.maxTabContentWidth,
                onBack: () => Navigator.of(context).maybePop(),
              ),
              Expanded(child: _body(context, state)),
            ],
          ),
        );
      },
    );
  }

  Widget _body(BuildContext context, ProfileEditState state) {
    if (state.status == ProfileEditStatus.loading) {
      return const BbStatusView.loading();
    }
    if (state.status == ProfileEditStatus.failed) {
      return BbStatusView(
        icon: failureReason(state.failure).icon,
        title: 'Profile load nahi hui.',
        subtitle: failureReason(state.failure).reason,
        action: FilledButton(
          onPressed: () => context.read<ProfileEditCubit>().load(),
          child: const Text('Try again'),
        ),
      );
    }
    final ProfileEditCubit cubit = context.read<ProfileEditCubit>();
    return ListView(
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
      children: <Widget>[
        _WhatsappCard(
          initial: state.whatsapp,
          saving: state.saving.contains(ProfileEditSection.whatsapp),
          onSave: cubit.saveWhatsapp,
        ),
        const SizedBox(height: 12),
        _LanguagesCard(
          initial: state.languages,
          labels: state.languageLabels,
          saving: state.saving.contains(ProfileEditSection.languages),
          onSave: cubit.saveLanguages,
        ),
        const SizedBox(height: 12),
        _WorkInfoCard(
          workTypes: state.workTypes,
          salaryPeriod: state.salaryPeriod,
          commuteMaxKm: state.commuteMaxKm,
          willingToTravel: state.willingToTravel,
          availability: state.availability,
          jobTypeLabels: state.options?.jobType ?? const <String, String>{},
          saving: state.saving.contains(ProfileEditSection.attributes),
          cubit: cubit,
        ),
        const SizedBox(height: 12),
        _QualificationsCard(
          initialCertificates: state.certificates,
          initialTrainings: state.trainings,
          saving: state.saving.contains(ProfileEditSection.qualifications),
          onSave: cubit.saveQualifications,
        ),
        const SizedBox(height: 12),
        _PortfolioCard(
          initial: state.portfolio,
          saving: state.saving.contains(ProfileEditSection.portfolio),
          onSave: cubit.savePortfolio,
          onUploadMedia: cubit.uploadPortfolioMedia,
        ),
        const SizedBox(height: 12),
        _OccupationsCard(
          selected: state.occupations,
          savedLabels: state.occupationLabels,
          saving: state.saving.contains(ProfileEditSection.occupations),
          onSave: cubit.saveOccupations,
        ),
      ],
    );
  }
}

/// A card with the kit header and an optional save button in the header row.
class _SectionCard extends StatelessWidget {
  const _SectionCard({
    required this.icon,
    required this.title,
    required this.child,
    this.saving = false,
    this.onSave,
    this.saveLabel = 'Save',
  });

  final IconData icon;
  final String title;
  final Widget child;
  final bool saving;
  final Future<void> Function()? onSave;
  final String saveLabel;

  @override
  Widget build(BuildContext context) {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          KitCardHeader(icon: icon, title: title),
          const SizedBox(height: 12),
          child,
          if (onSave != null) ...<Widget>[
            const SizedBox(height: 12),
            BbButton(
              label: saveLabel,
              block: true,
              size: BbButtonSize.md,
              loading: saving,
              onPressed: saving ? null : () => onSave!(),
            ),
          ],
        ],
      ),
    );
  }
}

/// A labelled text field with the app's consistent small styling.
class _Field extends StatelessWidget {
  const _Field({
    required this.controller,
    required this.label,
    this.hint,
    this.keyboardType,
    this.inputFormatters,
    this.onChanged,
  });

  final TextEditingController controller;
  final String label;
  final String? hint;
  final TextInputType? keyboardType;
  final List<TextInputFormatter>? inputFormatters;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(label.toUpperCase(), style: OnboardingTypography.fieldMicroLabel()),
        const SizedBox(height: 6),
        TextField(
          controller: controller,
          keyboardType: keyboardType,
          inputFormatters: inputFormatters,
          onChanged: onChanged,
          style: OnboardingTypography.inter(size: 15, weight: FontWeight.w600),
          decoration: InputDecoration(
            hintText: hint,
            counterText: '',
            isDense: true,
            filled: true,
            fillColor: OnboardingColors.rowBg,
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(OnboardingRadii.row),
              borderSide: const BorderSide(color: OnboardingColors.borderSubtle),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(OnboardingRadii.row),
              borderSide: const BorderSide(color: OnboardingColors.borderSubtle),
            ),
          ),
        ),
      ],
    );
  }
}

// ---- WhatsApp --------------------------------------------------------------

class _WhatsappCard extends StatefulWidget {
  const _WhatsappCard({
    required this.initial,
    required this.saving,
    required this.onSave,
  });

  final String? initial;
  final bool saving;
  final Future<void> Function(String?) onSave;

  @override
  State<_WhatsappCard> createState() => _WhatsappCardState();
}

class _WhatsappCardState extends State<_WhatsappCard> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initial ?? '');

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// E.164 or null. A bare 10-digit number is normalised to +91 (the app's only
  /// onboarding country), never guessed for any other prefix.
  String? _normalise(String raw) {
    final String trimmed = raw.trim();
    if (trimmed.isEmpty) return null;
    final String digits = trimmed.replaceAll(RegExp(r'[^0-9+]'), '');
    if (digits.startsWith('+')) return digits;
    if (digits.length == 10) return '+91$digits';
    return '+$digits';
  }

  @override
  Widget build(BuildContext context) {
    return _SectionCard(
      icon: Icons.chat_outlined,
      title: 'WhatsApp number',
      saving: widget.saving,
      onSave: () async {
        await widget.onSave(_normalise(_controller.text));
      },
      saveLabel: 'Save number',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Sirf aapki copy mein. Employer ko kabhi nahi dikhega.',
            style: OnboardingTypography.bodyMuted(),
          ),
          const SizedBox(height: 10),
          _Field(
            controller: _controller,
            label: 'WhatsApp',
            hint: '+91 98765 43210',
            keyboardType: TextInputType.phone,
          ),
          if ((widget.initial ?? '').isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: widget.saving
                    ? null
                    : () {
                        _controller.clear();
                        widget.onSave(null);
                      },
                child: const Text('Number hataayein'),
              ),
            ),
        ],
      ),
    );
  }
}

// ---- Languages -------------------------------------------------------------

class _LanguagesCard extends StatefulWidget {
  const _LanguagesCard({
    required this.initial,
    required this.labels,
    required this.saving,
    required this.onSave,
  });

  final List<LanguageAbilityDto> initial;
  final Map<String, String> labels;
  final bool saving;
  final Future<void> Function(List<LanguageAbilityDto>) onSave;

  @override
  State<_LanguagesCard> createState() => _LanguagesCardState();
}

class _LanguagesCardState extends State<_LanguagesCard> {
  late final List<LanguageAbilityDto> _selected = <LanguageAbilityDto>[
    ...widget.initial,
  ];

  void _toggleLanguage(String slug) {
    final int i = _selected.indexWhere((LanguageAbilityDto l) => l.language == slug);
    setState(() {
      if (i >= 0) {
        _selected.removeAt(i);
      } else if (_selected.length < kMaxLanguages) {
        _selected.add(LanguageAbilityDto(language: slug, canSpeak: true));
      }
    });
  }

  void _toggleAbility(String slug, {bool? speak, bool? read, bool? write}) {
    final int i = _selected.indexWhere((LanguageAbilityDto l) => l.language == slug);
    if (i < 0) return;
    setState(() {
      _selected[i] = _selected[i].copyWith(
        canSpeak: speak,
        canRead: read,
        canWrite: write,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    // Only languages with a known label are pickable; a slug whose label the
    // vocabulary dropped is still renderable if already selected.
    final List<MapEntry<String, String>> all = widget.labels.entries.toList();
    return _SectionCard(
      icon: Icons.translate_rounded,
      title: 'Bhashayein',
      saving: widget.saving,
      onSave: () => widget.onSave(_selected),
      saveLabel: 'Save languages',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Aap kaunsi bhasha bol, padh ya likh sakte hain?',
            style: OnboardingTypography.bodyMuted(),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final MapEntry<String, String> e in all)
                KitSelectChip(
                  label: e.value,
                  selected:
                      _selected.any((LanguageAbilityDto l) => l.language == e.key),
                  onTap: () => _toggleLanguage(e.key),
                ),
            ],
          ),
          if (_selected.isNotEmpty) ...<Widget>[
            const SizedBox(height: 14),
            for (final LanguageAbilityDto l in _selected) ...<Widget>[
              _LanguageAbilityRow(
                label: widget.labels[l.language] ?? taxonomyLabel(l.language),
                ability: l,
                onToggle: (bool? s, bool? r, bool? w) =>
                    _toggleAbility(l.language, speak: s, read: r, write: w),
              ),
              const SizedBox(height: 8),
            ],
          ],
        ],
      ),
    );
  }
}

class _LanguageAbilityRow extends StatelessWidget {
  const _LanguageAbilityRow({
    required this.label,
    required this.ability,
    required this.onToggle,
  });

  final String label;
  final LanguageAbilityDto ability;
  final void Function(bool? speak, bool? read, bool? write) onToggle;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            label,
            style: OnboardingTypography.inter(size: 14, weight: FontWeight.w700),
          ),
        ),
        _AbilityChip(
          label: 'Bol',
          selected: ability.canSpeak,
          onTap: () => onToggle(!ability.canSpeak, null, null),
        ),
        const SizedBox(width: 6),
        _AbilityChip(
          label: 'Padh',
          selected: ability.canRead,
          onTap: () => onToggle(null, !ability.canRead, null),
        ),
        const SizedBox(width: 6),
        _AbilityChip(
          label: 'Likh',
          selected: ability.canWrite,
          onTap: () => onToggle(null, null, !ability.canWrite),
        ),
      ],
    );
  }
}

class _AbilityChip extends StatelessWidget {
  const _AbilityChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return FilterChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap(),
      visualDensity: VisualDensity.compact,
      labelStyle: OnboardingTypography.inter(size: 12, weight: FontWeight.w700),
      selectedColor: OnboardingColors.shiftBlue,
      checkmarkColor: OnboardingColors.safetyYellow,
    );
  }
}

// ---- Extended work attributes ---------------------------------------------

class _WorkInfoCard extends StatefulWidget {
  const _WorkInfoCard({
    required this.workTypes,
    required this.salaryPeriod,
    required this.commuteMaxKm,
    required this.willingToTravel,
    required this.availability,
    required this.jobTypeLabels,
    required this.saving,
    required this.cubit,
  });

  final Set<String> workTypes;
  final String? salaryPeriod;
  final int? commuteMaxKm;
  final bool willingToTravel;
  final AvailabilityDraft availability;
  final Map<String, String> jobTypeLabels;
  final bool saving;
  final ProfileEditCubit cubit;

  @override
  State<_WorkInfoCard> createState() => _WorkInfoCardState();
}

class _WorkInfoCardState extends State<_WorkInfoCard> {
  late final TextEditingController _commute = TextEditingController(
    text: widget.commuteMaxKm?.toString() ?? '',
  );
  late final TextEditingController _availabilityDate =
      TextEditingController(text: widget.availability.availableFrom ?? '');
  late final TextEditingController _notice = TextEditingController(
    text: widget.availability.noticePeriodDays?.toString() ?? '',
  );

  bool _workTypesTouched = false;
  bool _salaryTouched = false;
  bool _commuteTouched = false;
  bool _travelTouched = false;
  bool _availabilityTouched = false;

  @override
  void dispose() {
    _commute.dispose();
    _availabilityDate.dispose();
    _notice.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _SectionCard(
      icon: Icons.tune_rounded,
      title: 'Kaam ki jaankari',
      saving: widget.saving,
      onSave: () => widget.cubit.saveExtendedAttributes(
        workTypesTouched: _workTypesTouched,
        salaryPeriodTouched: _salaryTouched,
        commuteTouched: _commuteTouched,
        travelTouched: _travelTouched,
        availabilityTouched: _availabilityTouched,
      ),
      saveLabel: 'Save kaam ki jaankari',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('Work type', style: OnboardingTypography.fieldMicroLabel()),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final MapEntry<String, String> e in widget.jobTypeLabels.entries)
                KitSelectChip(
                  label: e.value,
                  selected: widget.cubit.state.workTypes.contains(e.key),
                  onTap: () {
                    setState(() => _workTypesTouched = true);
                    widget.cubit.toggleWorkType(e.key);
                  },
                ),
            ],
          ),
          const SizedBox(height: 16),
          Text('Salary kiske hisaab se?',
              style: OnboardingTypography.fieldMicroLabel()),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final MapEntry<String, String> e in kSalaryPeriods.entries)
                KitSelectChip(
                  label: e.value,
                  selected: widget.cubit.state.salaryPeriod == e.key,
                  onTap: () {
                    _salaryTouched = true;
                    widget.cubit.setSalaryPeriod(
                      widget.cubit.state.salaryPeriod == e.key ? null : e.key,
                    );
                  },
                ),
            ],
          ),
          const SizedBox(height: 16),
          _Field(
            controller: _commute,
            label: 'Kitne km tak aayenge',
            hint: '0–500',
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(3),
            ],
            onChanged: (String v) {
              _commuteTouched = true;
              final int? km = int.tryParse(v);
              if (km == null || (km >= 0 && km <= 500)) {
                widget.cubit.setCommuteMaxKm(km);
              }
            },
          ),
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Kaam ke liye travel kar sakte hain'),
            value: widget.cubit.state.willingToTravel,
            onChanged: (bool v) {
              _travelTouched = true;
              widget.cubit.setWillingToTravel(v);
            },
          ),
          const SizedBox(height: 8),
          Text('Kab se available', style: OnboardingTypography.fieldMicroLabel()),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final MapEntry<String, String> e in kAvailabilityStatuses.entries)
                KitSelectChip(
                  label: e.value,
                  selected: widget.cubit.state.availability.status == e.key,
                  onTap: () {
                    _availabilityTouched = true;
                    widget.cubit.setAvailability(
                      widget.cubit.state.availability.copyWith(
                        status: widget.cubit.state.availability.status == e.key
                            ? null
                            : e.key,
                      ),
                    );
                  },
                ),
            ],
          ),
          const SizedBox(height: 12),
          _Field(
            controller: _availabilityDate,
            label: 'Available from',
            hint: 'YYYY-MM-DD',
            keyboardType: TextInputType.datetime,
            onChanged: (String v) {
              _availabilityTouched = true;
              final String? date = _validDate(v);
              widget.cubit.setAvailability(
                widget.cubit.state.availability.copyWith(availableFrom: date),
              );
            },
          ),
          const SizedBox(height: 12),
          _Field(
            controller: _notice,
            label: 'Notice period (din)',
            hint: '0–180',
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(3),
            ],
            onChanged: (String v) {
              _availabilityTouched = true;
              final int? days = int.tryParse(v);
              if (days == null || (days >= 0 && days <= 180)) {
                widget.cubit.setAvailability(
                  widget.cubit.state.availability.copyWith(noticePeriodDays: days),
                );
              }
            },
          ),
        ],
      ),
    );
  }

  /// A `YYYY-MM-DD` string, or null when blank/invalid (an invalid part is
  /// withheld rather than sent as a malformed date).
  String? _validDate(String v) {
    final String t = v.trim();
    if (t.isEmpty) return null;
    return RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(t) ? t : null;
  }
}

// ---- Training + licence ----------------------------------------------------

class _QualificationsCard extends StatefulWidget {
  const _QualificationsCard({
    required this.initialCertificates,
    required this.initialTrainings,
    required this.saving,
    required this.onSave,
  });

  final List<CertificateEntryDto> initialCertificates;
  final List<TrainingEntryDto> initialTrainings;
  final bool saving;
  final Future<void> Function(Map<String, dynamic> fields) onSave;

  @override
  State<_QualificationsCard> createState() => _QualificationsCardState();
}

class _QualificationsCardState extends State<_QualificationsCard> {
  late final List<_CertificateDraft> _certificates = widget.initialCertificates
      .map(_CertificateDraft.fromDto)
      .toList();
  late final List<_TrainingDraft> _trainings =
      widget.initialTrainings.map(_TrainingDraft.fromDto).toList();
  bool _certificatesTouched = false;
  bool _trainingsTouched = false;

  @override
  void dispose() {
    for (final _CertificateDraft c in _certificates) {
      c.dispose();
    }
    for (final _TrainingDraft t in _trainings) {
      t.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    final Map<String, dynamic> body = <String, dynamic>{};
    if (_certificatesTouched) {
      body['certificates'] = _certificates
          .where((_CertificateDraft c) => !c.isBlank)
          .map((_CertificateDraft c) => c.toJson())
          .toList();
    }
    if (_trainingsTouched) {
      body['trainings'] = _trainings
          .where((_TrainingDraft t) => !t.isBlank)
          .map((_TrainingDraft t) => t.toJson())
          .toList();
    }
    if (body.isEmpty) return;
    await widget.onSave(body);
  }

  @override
  Widget build(BuildContext context) {
    return _SectionCard(
      icon: Icons.school_outlined,
      title: 'Training aur licence',
      saving: widget.saving,
      onSave: _save,
      saveLabel: 'Save training/licence',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('Certificate (licence number/expiry sirf aapko dikhega)',
              style: OnboardingTypography.bodyMuted()),
          const SizedBox(height: 10),
          for (int i = 0; i < _certificates.length; i++) ...<Widget>[
            _CertificateEditor(
              draft: _certificates[i],
              onChanged: () => setState(() => _certificatesTouched = true),
              onRemove: () => setState(() {
                _certificatesTouched = true;
                _certificates.removeAt(i).dispose();
              }),
            ),
            const SizedBox(height: 10),
          ],
          if (_certificates.length < kMaxCertificates)
            TextButton.icon(
              onPressed: () => setState(() {
                _certificatesTouched = true;
                _certificates.add(_CertificateDraft());
              }),
              icon: const Icon(Icons.add),
              label: const Text('Certificate jodein'),
            ),
          const Divider(height: 24),
          Text('Training / course', style: OnboardingTypography.fieldMicroLabel()),
          const SizedBox(height: 10),
          for (int i = 0; i < _trainings.length; i++) ...<Widget>[
            _TrainingEditor(
              draft: _trainings[i],
              onChanged: () => setState(() => _trainingsTouched = true),
              onRemove: () => setState(() {
                _trainingsTouched = true;
                _trainings.removeAt(i).dispose();
              }),
            ),
            const SizedBox(height: 10),
          ],
          if (_trainings.length < kMaxTrainings)
            TextButton.icon(
              onPressed: () => setState(() {
                _trainingsTouched = true;
                _trainings.add(_TrainingDraft());
              }),
              icon: const Icon(Icons.add),
              label: const Text('Training jodein'),
            ),
        ],
      ),
    );
  }
}

class _CertificateDraft {
  _CertificateDraft({
    String? name,
    String? issuer,
    String? year,
    String? licenceNumber,
    String? licenceExpiry,
  })  : name = TextEditingController(text: name ?? ''),
        issuer = TextEditingController(text: issuer ?? ''),
        year = TextEditingController(text: year ?? ''),
        licenceNumber = TextEditingController(text: licenceNumber ?? ''),
        licenceExpiry = TextEditingController(text: licenceExpiry ?? '');

  factory _CertificateDraft.fromDto(CertificateEntryDto d) => _CertificateDraft(
        name: d.name,
        issuer: d.issuer,
        year: d.year?.toString(),
        licenceNumber: d.licenceNumber,
        licenceExpiry: d.licenceExpiry,
      );

  final TextEditingController name;
  final TextEditingController issuer;
  final TextEditingController year;
  final TextEditingController licenceNumber;
  final TextEditingController licenceExpiry;

  bool get isBlank =>
      name.text.trim().isEmpty &&
      issuer.text.trim().isEmpty &&
      year.text.trim().isEmpty &&
      licenceNumber.text.trim().isEmpty &&
      licenceExpiry.text.trim().isEmpty;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name.text.trim(),
        'issuer': _orNull(issuer.text),
        'year': int.tryParse(year.text.trim()),
        'licence_number': _orNull(licenceNumber.text),
        'licence_expiry': _orNull(licenceExpiry.text),
      };

  void dispose() {
    name.dispose();
    issuer.dispose();
    year.dispose();
    licenceNumber.dispose();
    licenceExpiry.dispose();
  }
}

class _CertificateEditor extends StatelessWidget {
  const _CertificateEditor({
    required this.draft,
    required this.onChanged,
    required this.onRemove,
  });

  final _CertificateDraft draft;
  final VoidCallback onChanged;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: OnboardingColors.rowBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      child: Column(
        children: <Widget>[
          _Field(
            controller: draft.name,
            label: 'Certificate name',
            onChanged: (_) => onChanged(),
          ),
          const SizedBox(height: 10),
          _Field(
            controller: draft.issuer,
            label: 'Issuer',
            onChanged: (_) => onChanged(),
          ),
          const SizedBox(height: 10),
          _Field(
            controller: draft.year,
            label: 'Saal',
            hint: 'YYYY',
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(4),
            ],
            onChanged: (_) => onChanged(),
          ),
          const SizedBox(height: 10),
          _Field(
            controller: draft.licenceNumber,
            label: 'Licence number (private)',
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.allow(RegExp('[A-Za-z0-9/\\- ]')),
              LengthLimitingTextInputFormatter(64),
            ],
            onChanged: (_) => onChanged(),
          ),
          const SizedBox(height: 10),
          _Field(
            controller: draft.licenceExpiry,
            label: 'Licence expiry (private)',
            hint: 'YYYY-MM-DD',
            keyboardType: TextInputType.datetime,
            onChanged: (_) => onChanged(),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: onRemove,
              child: const Text('Hataayein'),
            ),
          ),
        ],
      ),
    );
  }
}

class _TrainingDraft {
  _TrainingDraft({String? name, String? provider, String? year})
      : name = TextEditingController(text: name ?? ''),
        provider = TextEditingController(text: provider ?? ''),
        year = TextEditingController(text: year ?? '');

  factory _TrainingDraft.fromDto(TrainingEntryDto d) => _TrainingDraft(
        name: d.name,
        provider: d.provider,
        year: d.year?.toString(),
      );

  final TextEditingController name;
  final TextEditingController provider;
  final TextEditingController year;

  bool get isBlank =>
      name.text.trim().isEmpty &&
      provider.text.trim().isEmpty &&
      year.text.trim().isEmpty;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'name': name.text.trim(),
        'provider': _orNull(provider.text),
        'year': int.tryParse(year.text.trim()),
      };

  void dispose() {
    name.dispose();
    provider.dispose();
    year.dispose();
  }
}

class _TrainingEditor extends StatelessWidget {
  const _TrainingEditor({
    required this.draft,
    required this.onChanged,
    required this.onRemove,
  });

  final _TrainingDraft draft;
  final VoidCallback onChanged;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: OnboardingColors.rowBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      child: Column(
        children: <Widget>[
          _Field(
            controller: draft.name,
            label: 'Training ka naam',
            onChanged: (_) => onChanged(),
          ),
          const SizedBox(height: 10),
          _Field(
            controller: draft.provider,
            label: 'Kahan se',
            onChanged: (_) => onChanged(),
          ),
          const SizedBox(height: 10),
          _Field(
            controller: draft.year,
            label: 'Saal',
            hint: 'YYYY',
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(4),
            ],
            onChanged: (_) => onChanged(),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: onRemove,
              child: const Text('Hataayein'),
            ),
          ),
        ],
      ),
    );
  }
}

String? _orNull(String v) {
  final String t = v.trim();
  return t.isEmpty ? null : t;
}

// ---- Portfolio -------------------------------------------------------------

class _PortfolioCard extends StatefulWidget {
  const _PortfolioCard({
    required this.initial,
    required this.saving,
    required this.onSave,
    required this.onUploadMedia,
  });

  final List<PortfolioItemDto> initial;
  final bool saving;
  final Future<void> Function(List<PortfolioItemDto> items) onSave;
  final Future<void> Function(PickedPortfolioMedia media, {String? caption})
      onUploadMedia;

  @override
  State<_PortfolioCard> createState() => _PortfolioCardState();
}

class _PortfolioCardState extends State<_PortfolioCard> {
  late List<PortfolioItemDto> _items = <PortfolioItemDto>[...widget.initial];

  Future<void> _addLink() async {
    final TextEditingController url = TextEditingController();
    final TextEditingController caption = TextEditingController();
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('Link jodein'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _Field(
              controller: url,
              label: 'Link',
              hint: 'https://…',
              keyboardType: TextInputType.url,
            ),
            const SizedBox(height: 10),
            _Field(controller: caption, label: 'Caption (optional)'),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Jodein'),
          ),
        ],
      ),
    );
    final String trimmed = url.text.trim();
    if (ok == true &&
        trimmed.startsWith('http') &&
        _items.length < kMaxPortfolioItems) {
      final List<PortfolioItemDto> next = <PortfolioItemDto>[
        ..._items,
        PortfolioItemDto(
          kind: 'link',
          url: trimmed,
          caption: _orNull(caption.text),
        ),
      ];
      setState(() => _items = next);
      await widget.onSave(next);
    }
    url.dispose();
    caption.dispose();
  }

  Future<void> _addMedia() async {
    final FilePickerResult? result;
    try {
      result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: const <String>['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov'],
        allowMultiple: false,
        withData: true,
      );
    } catch (_) {
      return;
    }
    final PlatformFile? file =
        result?.files.isNotEmpty == true ? result!.files.first : null;
    if (file == null) return;
    final String ext = file.extension?.toLowerCase() ?? '';
    final String kind = (ext == 'mp4' || ext == 'mov') ? 'video' : 'photo';
    final List<int>? bytes = file.bytes;
    if (bytes == null) return;
    final String contentType = switch (ext) {
      'png' => 'image/png',
      'webp' => 'image/webp',
      'mp4' => 'video/mp4',
      'mov' => 'video/quicktime',
      _ => 'image/jpeg',
    };
    await widget.onUploadMedia(
      PickedPortfolioMedia(
        kind: kind,
        contentType: contentType,
        bytes: bytes,
        sizeBytes: file.size,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return _SectionCard(
      icon: Icons.photo_library_outlined,
      title: 'Portfolio',
      saving: widget.saving,
      saveLabel: 'Refresh',
      onSave: () async => widget.onSave(_items),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Apne kaam ki photo, video ya link. (Media upload server pe '
            'configure hone tak sirf link chalega.)',
            style: OnboardingTypography.bodyMuted(),
          ),
          const SizedBox(height: 10),
          if (_items.isEmpty)
            Text('Abhi kuch nahi.', style: OnboardingTypography.bodyMuted())
          else
            for (int i = 0; i < _items.length; i++) ...<Widget>[
              _PortfolioRow(
                item: _items[i],
                onRemove: () async {
                  final List<PortfolioItemDto> next = <PortfolioItemDto>[..._items]
                    ..removeAt(i);
                  setState(() => _items = next);
                  await widget.onSave(next);
                },
              ),
              const SizedBox(height: 8),
            ],
          if (_items.length < kMaxPortfolioItems)
            Row(
              children: <Widget>[
                TextButton.icon(
                  onPressed: _addLink,
                  icon: const Icon(Icons.link),
                  label: const Text('Link'),
                ),
                TextButton.icon(
                  onPressed: _addMedia,
                  icon: const Icon(Icons.add_photo_alternate_outlined),
                  label: const Text('Photo/Video'),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _PortfolioRow extends StatelessWidget {
  const _PortfolioRow({required this.item, required this.onRemove});

  final PortfolioItemDto item;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final String label = item.kind == 'link'
        ? (item.url ?? '')
        : item.kind == 'video'
            ? 'Video'
            : 'Photo';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: OnboardingColors.rowBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      child: Row(
        children: <Widget>[
          Icon(
            item.kind == 'link' ? Icons.link : Icons.image_outlined,
            size: 18,
            color: OnboardingColors.ink500,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: OnboardingTypography.inter(size: 13, weight: FontWeight.w600),
                ),
                if ((item.caption ?? '').isNotEmpty)
                  Text(
                    item.caption!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: OnboardingTypography.bodyMuted(),
                  ),
              ],
            ),
          ),
          IconButton(
            onPressed: onRemove,
            icon: const Icon(Icons.close, size: 18),
          ),
        ],
      ),
    );
  }
}

// ---- Secondary occupations -------------------------------------------------

class _OccupationsCard extends StatefulWidget {
  const _OccupationsCard({
    required this.selected,
    required this.savedLabels,
    required this.saving,
    required this.onSave,
  });

  final List<String> selected;
  final Map<String, String> savedLabels;
  final bool saving;
  final Future<void> Function(List<String> roleIds) onSave;

  @override
  State<_OccupationsCard> createState() => _OccupationsCardState();
}

class _OccupationsCardState extends State<_OccupationsCard> {
  late final List<String> _selected = <String>[...widget.selected];

  @override
  Widget build(BuildContext context) {
    return _SectionCard(
      icon: Icons.handyman_outlined,
      title: 'Aur kaam (occupation)',
      saving: widget.saving,
      onSave: () => widget.onSave(_selected),
      saveLabel: 'Save kaam',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            'Aap aur kaunse kaam kar sakte hain? (max $kMaxSecondaryOccupations)',
            style: OnboardingTypography.bodyMuted(),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final String id in kSecondaryRoleIds)
                KitSelectChip(
                  label: widget.savedLabels[id] ?? taxonomyLabel(id),
                  selected: _selected.contains(id),
                  onTap: () => setState(() {
                    if (_selected.contains(id)) {
                      _selected.remove(id);
                    } else if (_selected.length < kMaxSecondaryOccupations) {
                      _selected.add(id);
                    }
                  }),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
