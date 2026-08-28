import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_client.dart' show WorkPrefOptionsDto;
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_toggle.dart';
import '../../../router.dart';
import '../../voice_form/presentation/widgets/voice_dot_rail.dart';
import '../domain/finishing_models.dart';
import 'cubit/finishing_cubit.dart';
import 'widgets/employer_card.dart';

// ---- Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart. ----

const String _kRewardLine =
    'Bas kuch aakhri baatein — phir aapka resume taiyaar ho jayega.';

const String _kLangTitle = 'Aap kaun si bhasha bolte hain?';
const String _kLangSubtitle = 'Jitni bhasha aati hain, sab chunein.';

const String _kDocTitle = 'Kaun se document taiyaar hain?';
const String _kDocSubtitle = 'Jo aapke paas hain, unhe chunein.';

const String _kShiftTitle = 'Kaam ka time aur type';
const String _kShiftSubtitle = 'Jo aapko theek lage, chunein.';
const String _kShiftLabel = 'Shift';
const String _kJobTypeLabel = 'Naukri ka type';

const String _kCitiesTitle = 'Kahan kaam karna chahte hain?';
const String _kCitiesSubtitle = 'Sheher daalein — ek se zyada bhi chalega.';
const String _kCityHint = 'Sheher ka naam likhein';
const String _kRelocateLabel = 'Doosre sheher ja sakte hain?';
const String _kAccommodationLabel = 'Rehne ki jagah chahiye?';

const String _kPayEduTitle = 'Salary aur padhai';
const String _kPayEduSubtitle = 'Jo laagu ho, wahi bharein — sab optional hai.';
const String _kSalaryMaxLabel = 'Zyada se zyada salary (mahina)';
const String _kSalaryMaxHint = 'Jaise: 25000';
const String _kCredentialLabel = 'Agar ITI ya Diploma hai to kaun sa?';
const String _kCouncilLabel = 'Council / board';
const String _kEduYearLabel = 'Kis saal poora hua';
const String _kEduYearHint = 'Jaise: 2018';
const String _kInstituteLabel = 'Institute ka naam';
const String _kInstituteHint = 'Jaise: Govt. ITI, Faridabad';

// #1298 — the education vocabularies are NOT served by the options endpoint, so
// they are pinned here from the authoritative source
// (apps/api/src/profiles/worker-preferences.vocabulary.ts). A slug outside these
// dictionaries is rejected by the API, so keep them in lockstep with that file.
const Map<String, String> _kCredentials = <String, String>{
  'iti': 'ITI',
  'diploma': 'Diploma',
};
const Map<String, String> _kCouncils = <String, String>{
  'ncvt': 'NCVT',
  'scvt': 'SCVT',
  'nsqf': 'NSQF',
  'aicte': 'AICTE',
  'state_board': 'State board',
  'cbse': 'CBSE',
  'icse': 'ICSE',
  'open_school': 'NIOS / Open school',
};

// Server bounds (worker-preferences.dto.ts) — guard at the input edge so an
// out-of-range number is simply not sent, never a doomed 400.
const int _kSalaryMin = 1000;
const int _kSalaryMax = 500000;
const int _kYearMin = 1950;
const int _kYearMax = 2100;

const String _kHistoryTitle = 'Aapne pehle kahan kaam kiya?';
const String _kHistorySubtitle = 'Zyada se zyada 4 jagah likh sakte hain.';
const String _kAddEmployer = 'Aur ek jagah jodein';

const String _kNext = 'Aage badhein';
const String _kFinish = 'Ho gaya';
const String _kLoading = 'Taiyaari ho rahi hai…';
const String _kRetry = 'Dobara koshish karein';

/// The post-interview finishing form (#1296) — five closed-set pages that fill
/// the résumé rows the interview's ask-budget cannot afford. Reached straight
/// after the interview confirms, before the first résumé generate; on completion
/// it routes to [Routes.building].
class FinishingScreen extends StatelessWidget {
  const FinishingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<FinishingCubit>(
      create: (_) => locator<FinishingCubit>()..load(),
      child: const _FinishingView(),
    );
  }
}

class _FinishingView extends StatelessWidget {
  const _FinishingView();

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<FinishingCubit, FinishingState>(
      listenWhen: (FinishingState p, FinishingState c) => p.status != c.status,
      listener: (BuildContext context, FinishingState state) {
        if (state.status == FinishingStatus.done) {
          // The two writes have landed — generate the résumé they just filled.
          context.go(Routes.building);
        }
      },
      builder: (BuildContext context, FinishingState state) {
        switch (state.status) {
          case FinishingStatus.loadingOptions:
            return const _StatusScaffold(child: _LoadingBody());
          case FinishingStatus.loadError:
            return _StatusScaffold(
              child: _ErrorBody(
                message: state.error ?? _kRetry,
                onRetry: () => context.read<FinishingCubit>().load(),
              ),
            );
          case FinishingStatus.ready:
          case FinishingStatus.submitting:
          case FinishingStatus.done:
            return _WizardScaffold(state: state);
        }
      },
    );
  }
}

/// A bare blue-header scaffold for the pre-form loading / error states.
class _StatusScaffold extends StatelessWidget {
  const _StatusScaffold({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.canvas,
      body: Column(
        children: <Widget>[
          const BbBlueHeader(
            title: _kHistoryTitle,
            subtitle: _kRewardLine,
          ),
          Expanded(child: SafeArea(top: false, child: child)),
        ],
      ),
    );
  }
}

class _LoadingBody extends StatelessWidget {
  const _LoadingBody();
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const CircularProgressIndicator(color: AppColors.blue),
          const SizedBox(height: AppSpacing.s4),
          Text(_kLoading,
              style: AppTypography.body(
                  size: AppTypography.sizeBase, color: AppColors.textMuted)),
        ],
      ),
    );
  }
}

class _ErrorBody extends StatelessWidget {
  const _ErrorBody({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(message,
                textAlign: TextAlign.center,
                style: AppTypography.body(size: AppTypography.sizeMd)),
            const SizedBox(height: AppSpacing.s4),
            BbButton(
              label: _kRetry,
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.md,
              onPressed: onRetry,
            ),
          ],
        ),
      ),
    );
  }
}

/// The five-page wizard chrome: header (per-page title + back-to-previous-page),
/// a grow-only dot rail, the swapped page body, and a sticky advance button.
class _WizardScaffold extends StatelessWidget {
  const _WizardScaffold({required this.state});
  final FinishingState state;

  static const List<String> _titles = <String>[
    _kLangTitle,
    _kDocTitle,
    _kShiftTitle,
    _kCitiesTitle,
    _kPayEduTitle,
    _kHistoryTitle,
  ];
  static const List<String> _subtitles = <String>[
    _kLangSubtitle,
    _kDocSubtitle,
    _kShiftSubtitle,
    _kCitiesSubtitle,
    _kPayEduSubtitle,
    _kHistorySubtitle,
  ];

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    final int i = state.pageIndex;
    return Scaffold(
      backgroundColor: AppColors.canvas,
      body: Column(
        children: <Widget>[
          BbBlueHeader(
            title: _titles[i],
            subtitle: _subtitles[i],
            onBack: state.isFirstPage ? null : cubit.previousPage,
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: Column(
                children: <Widget>[
                  const SizedBox(height: AppSpacing.s4),
                  VoiceDotRail(
                    filled: state.pageIndex + 1,
                    total: FinishingPage.values.length,
                  ),
                  // The finishing form IS the reward — say so once, on page one.
                  if (state.isFirstPage) ...<Widget>[
                    const SizedBox(height: AppSpacing.s3),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.gutter),
                      child: Text(
                        _kRewardLine,
                        textAlign: TextAlign.center,
                        style: AppTypography.body(
                            size: AppTypography.sizeSm,
                            color: AppColors.textMuted),
                      ),
                    ),
                  ],
                  Expanded(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(AppSpacing.gutter,
                          AppSpacing.s4, AppSpacing.gutter, AppSpacing.s4),
                      child: _PageBody(state: state),
                    ),
                  ),
                  _BottomBar(state: state),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PageBody extends StatelessWidget {
  const _PageBody({required this.state});
  final FinishingState state;

  @override
  Widget build(BuildContext context) {
    final WorkPrefOptionsDto options = state.options!;
    final FinishingCubit cubit = context.read<FinishingCubit>();
    switch (state.page) {
      case FinishingPage.languages:
        return _MultiChips(
          labels: options.languages,
          selected: state.prefs.languages,
          onTap: cubit.toggleLanguage,
        );
      case FinishingPage.documents:
        return _MultiChips(
          labels: options.documentsReady,
          selected: state.prefs.documentsReady,
          onTap: cubit.toggleDocument,
        );
      case FinishingPage.shiftAndType:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _SectionLabel(_kShiftLabel),
            _SingleChips(
              labels: options.shift,
              selected: state.prefs.shift,
              onTap: cubit.selectShift,
            ),
            const SizedBox(height: AppSpacing.s5),
            _SectionLabel(_kJobTypeLabel),
            _SingleChips(
              labels: options.jobType,
              selected: state.prefs.jobType,
              onTap: cubit.selectJobType,
            ),
          ],
        );
      case FinishingPage.cities:
        return _CitiesPage(state: state);
      case FinishingPage.salaryEducation:
        return _SalaryEducationPage(state: state);
      case FinishingPage.history:
        return _HistoryPage(state: state);
    }
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: AppSpacing.s2),
        child: Text(text, style: AppTypography.eyebrow()),
      );
}

class _MultiChips extends StatelessWidget {
  const _MultiChips({
    required this.labels,
    required this.selected,
    required this.onTap,
  });
  final Map<String, String> labels;
  final Set<String> selected;
  final void Function(String slug) onTap;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        for (final MapEntry<String, String> e in labels.entries)
          BbChip(
            label: e.value,
            selected: selected.contains(e.key),
            icon: selected.contains(e.key) ? Icons.check : null,
            onTap: () => onTap(e.key),
          ),
      ],
    );
  }
}

class _SingleChips extends StatelessWidget {
  const _SingleChips({
    required this.labels,
    required this.selected,
    required this.onTap,
  });
  final Map<String, String> labels;
  final String? selected;
  final void Function(String slug) onTap;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.s2,
      runSpacing: AppSpacing.s2,
      children: <Widget>[
        for (final MapEntry<String, String> e in labels.entries)
          BbChip(
            label: e.value,
            selected: selected == e.key,
            icon: selected == e.key ? Icons.check : null,
            onTap: () => onTap(e.key),
          ),
      ],
    );
  }
}

class _CitiesPage extends StatefulWidget {
  const _CitiesPage({required this.state});
  final FinishingState state;
  @override
  State<_CitiesPage> createState() => _CitiesPageState();
}

class _CitiesPageState extends State<_CitiesPage> {
  final TextEditingController _city = TextEditingController();

  @override
  void dispose() {
    _city.dispose();
    super.dispose();
  }

  void _add() {
    final String value = _city.text.trim();
    if (value.isEmpty) return;
    context.read<FinishingCubit>().addCity(value);
    _city.clear();
  }

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    final FinishingState state = widget.state;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: FinishingTextField(
                controller: _city,
                hint: _kCityHint,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _add(),
              ),
            ),
            const SizedBox(width: AppSpacing.s2),
            BbButton(
              label: '+',
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.md,
              onPressed: _add,
            ),
          ],
        ),
        if (state.prefs.preferredCities.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final String c in state.prefs.preferredCities)
                BbChip(
                  label: c,
                  selected: true,
                  icon: Icons.close,
                  onTap: () => cubit.removeCity(c),
                ),
            ],
          ),
        ],
        const SizedBox(height: AppSpacing.s5),
        _ToggleRow(
          label: _kRelocateLabel,
          value: state.prefs.willingToRelocate,
          onChanged: cubit.setRelocate,
        ),
        const SizedBox(height: AppSpacing.s3),
        _ToggleRow(
          label: _kAccommodationLabel,
          value: state.prefs.accommodationNeeded,
          onChanged: cubit.setAccommodation,
        ),
      ],
    );
  }
}

class _ToggleRow extends StatelessWidget {
  const _ToggleRow({
    required this.label,
    required this.value,
    required this.onChanged,
  });
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(label,
              style: AppTypography.body(size: AppTypography.sizeBase)),
        ),
        const SizedBox(width: AppSpacing.s2),
        BbToggle(value: value, onChanged: onChanged, semanticLabel: label),
      ],
    );
  }
}

/// Salary band max + the ITI/Diploma credential group (#1298). Everything here
/// is optional: a worker who skips it keeps whatever the interview captured. The
/// number fields are range-guarded at the edge, so only a valid value is ever
/// sent and an out-of-range entry simply produces no band / no year.
class _SalaryEducationPage extends StatefulWidget {
  const _SalaryEducationPage({required this.state});
  final FinishingState state;
  @override
  State<_SalaryEducationPage> createState() => _SalaryEducationPageState();
}

class _SalaryEducationPageState extends State<_SalaryEducationPage> {
  late final TextEditingController _salary = TextEditingController(
      text: widget.state.prefs.salaryExpectedMax?.toString() ?? '');
  late final TextEditingController _year = TextEditingController(
      text: widget.state.prefs.educationYear?.toString() ?? '');
  late final TextEditingController _institute = TextEditingController(
      text: widget.state.prefs.educationInstitute ?? '');

  @override
  void dispose() {
    _salary.dispose();
    _year.dispose();
    _institute.dispose();
    super.dispose();
  }

  int? _inRange(String s, int lo, int hi) {
    final int? v = int.tryParse(s.trim());
    if (v == null || v < lo || v > hi) return null;
    return v;
  }

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    final WorkPreferences prefs = widget.state.prefs;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _SectionLabel(_kSalaryMaxLabel),
        FinishingTextField(
          controller: _salary,
          hint: _kSalaryMaxHint,
          label: _kSalaryMaxLabel,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.next,
          onChanged: (String v) =>
              cubit.setSalaryMax(_inRange(v, _kSalaryMin, _kSalaryMax)),
        ),
        const SizedBox(height: AppSpacing.s5),
        _SectionLabel(_kCredentialLabel),
        _SingleChips(
          labels: _kCredentials,
          selected: prefs.educationCredential,
          onTap: cubit.selectCredential,
        ),
        const SizedBox(height: AppSpacing.s5),
        _SectionLabel(_kCouncilLabel),
        _SingleChips(
          labels: _kCouncils,
          selected: prefs.educationCouncil,
          onTap: cubit.selectCouncil,
        ),
        const SizedBox(height: AppSpacing.s5),
        _SectionLabel(_kEduYearLabel),
        FinishingTextField(
          controller: _year,
          hint: _kEduYearHint,
          label: _kEduYearLabel,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.next,
          onChanged: (String v) =>
              cubit.setEducationYear(_inRange(v, _kYearMin, _kYearMax)),
        ),
        const SizedBox(height: AppSpacing.s5),
        _SectionLabel(_kInstituteLabel),
        FinishingTextField(
          controller: _institute,
          hint: _kInstituteHint,
          label: _kInstituteLabel,
          maxLength: 120,
          textInputAction: TextInputAction.done,
          onChanged: cubit.setInstitute,
        ),
      ],
    );
  }
}

class _HistoryPage extends StatelessWidget {
  const _HistoryPage({required this.state});
  final FinishingState state;

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        for (int i = 0; i < state.employments.length; i++) ...<Widget>[
          EmployerCard(
            key: ValueKey<int>(i),
            entry: state.employments[i],
            onChanged: (entry) => cubit.updateEmployer(i, entry),
            onRemove: () => cubit.removeEmployer(i),
          ),
          const SizedBox(height: AppSpacing.s3),
        ],
        if (state.employments.length < kMaxEmployers)
          BbButton(
            label: _kAddEmployer,
            variant: BbButtonVariant.outline,
            size: BbButtonSize.md,
            iconLeft: Icons.add,
            block: true,
            onPressed: cubit.addEmployer,
          ),
      ],
    );
  }
}

/// The sticky advance/finish button (+ any inline submit error above it).
class _BottomBar extends StatelessWidget {
  const _BottomBar({required this.state});
  final FinishingState state;

  @override
  Widget build(BuildContext context) {
    final FinishingCubit cubit = context.read<FinishingCubit>();
    return Container(
      padding: const EdgeInsets.fromLTRB(AppSpacing.gutter, AppSpacing.s3,
          AppSpacing.gutter, AppSpacing.s4),
      decoration: const BoxDecoration(
        color: AppColors.canvas,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (state.submitError != null) ...<Widget>[
            Text(
              state.submitError!,
              style: AppTypography.body(
                  size: AppTypography.sizeSm, color: AppColors.danger),
            ),
            const SizedBox(height: AppSpacing.s2),
          ],
          BbButton(
            label: state.isLastPage ? _kFinish : _kNext,
            block: true,
            loading: state.isSubmitting,
            onPressed: state.isSubmitting
                ? null
                : (state.isLastPage ? cubit.submit : cubit.nextPage),
          ),
        ],
      ),
    );
  }
}
