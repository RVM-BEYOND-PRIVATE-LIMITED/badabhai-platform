import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/api/api_models.dart'
    show
        CertificateEntryDto,
        CorrectionRejected,
        EducationEntryDto,
        kMaxCorrectionsPerProfile;
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_info_chip.dart';
import 'cubit/extracted_review_cubit.dart';

/// The extracted-profile review surface (#1595, §8.4): what the interview
/// extraction recorded — skills, machines, experience, education,
/// certificates — with a correction affordance on every field the client
/// can validly write.
///
/// skills/machines render READ-ONLY chips: the extracted labels carry no
/// canonical ids and no worker-facing catalogue exists to select from, so
/// any affordance there would invent ids client-side (forbidden by §1.2).
/// A backend catalogue issue tracks the follow-up; until it ships, those
/// sections show values and nothing else.
///
/// Experience/education/certificates POST structured corrections
/// (bounded int / full-list replace), re-read after every accepted batch,
/// and confirm the corrected profile via the existing confirm endpoint.
/// 409s render honestly: unpinned-session deferral is surfaced, never
/// retried; the lifetime cap disables every affordance, never spins.
class ExtractedReviewScreen extends StatelessWidget {
  const ExtractedReviewScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ExtractedReviewCubit>(
      create: (_) => locator<ExtractedReviewCubit>()..load(),
      child: const _ExtractedReviewView(),
    );
  }
}

class _ExtractedReviewView extends StatelessWidget {
  const _ExtractedReviewView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile review')),
      body: BlocBuilder<ExtractedReviewCubit, ExtractedReviewState>(
        builder: (BuildContext context, ExtractedReviewState state) {
          switch (state.status) {
            case ExtractedReviewStatus.loading:
              return const Center(child: CircularProgressIndicator());
            case ExtractedReviewStatus.failed:
              final ({IconData icon, String reason}) why =
                  failureReason(state.failure);
              return Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Icon(why.icon, size: 40),
                      const SizedBox(height: 12),
                      const Text('Review load nahi hui.'),
                      const SizedBox(height: 6),
                      Text(why.reason, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      BbButton(
                        label: 'Dobara try karein',
                        onPressed: () =>
                            context.read<ExtractedReviewCubit>().load(),
                      ),
                    ],
                  ),
                ),
              );
            case ExtractedReviewStatus.ready:
              return const _ReviewBody();
          }
        },
      ),
    );
  }
}

class _ReviewBody extends StatelessWidget {
  const _ReviewBody();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ExtractedReviewCubit, ExtractedReviewState>(
      builder: (BuildContext context, ExtractedReviewState state) {
        final ExtractedReviewState s = state;
        return ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
          children: <Widget>[
            const Text(
              'Interview mein jo suna, wahi likha hai. Galat lage to sudhaarein — '
              'sahi lage to chhod dein.',
            ),
            const SizedBox(height: 12),
            if (!s.review!.canCorrect) ...<Widget>[
              const _AnchorBanner(),
              const SizedBox(height: 12),
            ],
            if (s.rejected == CorrectionRejected.unpinnedRoadDeferred &&
                s.deferralMessage != null) ...<Widget>[
              _NoticeBanner(text: s.deferralMessage!),
              const SizedBox(height: 12),
            ],
            if (s.rejected == CorrectionRejected.capReached) ...<Widget>[
              _NoticeBanner(
                  text: s.deferralMessage ??
                      'Sudhaar ki seema poori ho gayi (20).'),
              const SizedBox(height: 12),
            ],
            if (s.validationError != null) ...<Widget>[
              _NoticeBanner(text: s.validationError!, tone: _NoticeTone.error),
              const SizedBox(height: 12),
            ],
            if (s.lastSent != null) ...<Widget>[
              _NoticeBanner(
                text:
                    '${_fieldLabel(s.lastSent!.field)} sudhaar liya gaya — neeche taaza values hain.',
                tone: _NoticeTone.ok,
              ),
              const SizedBox(height: 12),
            ],
            _SkillsCard(state: s),
            const SizedBox(height: 12),
            _MachinesCard(state: s),
            const SizedBox(height: 12),
            _ExperienceCard(state: s),
            const SizedBox(height: 12),
            _EducationCard(state: s),
            const SizedBox(height: 12),
            _CertificatesCard(state: s),
            const SizedBox(height: 12),
            _ConfirmCard(state: s),
          ],
        );
      },
    );
  }
}

String _fieldLabel(String field) {
  switch (field) {
    case 'experience':
      return 'Anubhav';
    case 'education':
      return 'Taleem';
    case 'certificates':
      return 'Certificate';
    default:
      return field;
  }
}

enum _NoticeTone { info, error, ok }

class _NoticeBanner extends StatelessWidget {
  const _NoticeBanner({required this.text, this.tone = _NoticeTone.info});

  final String text;
  final _NoticeTone tone;

  @override
  Widget build(BuildContext context) {
    final Color bg = switch (tone) {
      _NoticeTone.info => OnboardingColors.infoBg,
      _NoticeTone.error => OnboardingColors.errorBg,
      _NoticeTone.ok => OnboardingColors.successBg,
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(text),
    );
  }
}

/// No pinned interview anchor (form-road / pre-interview) or budget spent:
/// values stay visible, saves stay off. The screen never POSTs anchor-less.
class _AnchorBanner extends StatelessWidget {
  const _AnchorBanner();

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ExtractedReviewCubit, ExtractedReviewState>(
      builder: (BuildContext context, ExtractedReviewState state) {
        final bool capped = (state.review?.correctionCount ?? 0) >=
                kMaxCorrectionsPerProfile ||
            state.rejected == CorrectionRejected.capReached;
        return _NoticeBanner(
          text: capped
              ? 'Sudhaar ki seema poori ho gayi (20). Naye sudhaar band hain — values neeche waise hi dikhengi.'
              : 'Interview wala sudhaar yahaan nahi ho sakta (koi interview record nahi mila). Values neeche waise hi dikhengi.',
        );
      },
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: OnboardingTypography.anek(
        size: 15,
        weight: FontWeight.w800,
      ),
    );
  }
}

class _SkillsCard extends StatelessWidget {
  const _SkillsCard({required this.state});

  final ExtractedReviewState state;

  @override
  Widget build(BuildContext context) {
    final List<String> skills = state.review?.skills ?? const <String>[];
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _SectionTitle('Hunar (skills)'),
          const SizedBox(height: 8),
          if (skills.isEmpty)
            const Text('Koi hunar darj nahi.')
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final String s in skills) KitInfoChip(label: s),
              ],
            ),
        ],
      ),
    );
  }
}

class _MachinesCard extends StatelessWidget {
  const _MachinesCard({required this.state});

  final ExtractedReviewState state;

  @override
  Widget build(BuildContext context) {
    final List<String> machines = state.review?.machines ?? const <String>[];
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _SectionTitle('Machinein'),
          const SizedBox(height: 8),
          if (machines.isEmpty)
            const Text('Koi machine darj nahi.')
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: <Widget>[
                for (final String m in machines) KitInfoChip(label: m),
              ],
            ),
        ],
      ),
    );
  }
}

class _ExperienceCard extends StatefulWidget {
  const _ExperienceCard({required this.state});

  final ExtractedReviewState state;

  @override
  State<_ExperienceCard> createState() => _ExperienceCardState();
}

class _ExperienceCardState extends State<_ExperienceCard> {
  final TextEditingController _years = TextEditingController();

  @override
  void dispose() {
    _years.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ExtractedReviewState s = widget.state;
    final String current = s.review?.experienceYears == null
        ? 'darj nahi'
        : '${s.review!.experienceYears} saal';
    // Seed the box once from the server value; the worker's keystrokes win
    // after that (a reload re-seeds only when the box is still pristine).
    if (_years.text.isEmpty && s.review?.experienceYears != null) {
      _years.text = '${s.review!.experienceYears}';
    }
    final bool busy = s.sendingSection == ExtractedSection.experience;
    final bool locked = s.correctionsLocked;
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _SectionTitle('Anubhav'),
          const SizedBox(height: 4),
          Text('Abhi darj: $current'),
          const SizedBox(height: 8),
          TextField(
            controller: _years,
            enabled: !locked && !busy,
            keyboardType: TextInputType.number,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(2),
            ],
            decoration: const InputDecoration(
              labelText: 'Kul saal (0–60)',
              hintText: 'Jaise: 8',
              border: OutlineInputBorder(),
            ),
            onChanged: (_) => context
                .read<ExtractedReviewCubit>()
                .setExperience(int.tryParse(_years.text.trim())),
          ),
          const SizedBox(height: 8),
          BbButton(
            label: 'Anubhav sudhaarein',
            loading: busy,
            onPressed: (!locked && !busy && s.expDirty)
                ? () =>
                    context.read<ExtractedReviewCubit>().submitExperience()
                : null,
          ),
        ],
      ),
    );
  }
}

String _eduLine(EducationEntryDto e) {
  final List<String> parts = <String>[
    if ((e.credential ?? '').trim().isNotEmpty) e.credential!.trim(),
    if ((e.field ?? '').trim().isNotEmpty) e.field!.trim(),
    if ((e.council ?? '').trim().isNotEmpty) e.council!.trim(),
    if ((e.institute ?? '').trim().isNotEmpty) e.institute!.trim(),
    if (e.year != null) '${e.year}',
  ];
  return parts.join(' · ');
}

class _EducationCard extends StatefulWidget {
  const _EducationCard({required this.state});

  final ExtractedReviewState state;

  @override
  State<_EducationCard> createState() => _EducationCardState();
}

class _EducationCardState extends State<_EducationCard> {
  final TextEditingController _field = TextEditingController();
  final TextEditingController _institute = TextEditingController();
  final TextEditingController _year = TextEditingController();
  String? _credential;
  String? _council;

  @override
  void dispose() {
    _field.dispose();
    _institute.dispose();
    _year.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ExtractedReviewState s = widget.state;
    final bool busy = s.sendingSection == ExtractedSection.education;
    final bool locked = s.correctionsLocked;
    final Map<String, String> credentials =
        s.options?.educationCredential ?? const <String, String>{};
    final Map<String, String> councils =
        s.options?.educationCouncil ?? const <String, String>{};
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _SectionTitle('Taleem'),
          const SizedBox(height: 8),
          if (s.eduRows.isEmpty) const Text('Koi taleem darj nahi.'),
          for (int i = 0; i < s.eduRows.length; i++)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(_eduLine(s.eduRows[i]).isEmpty
                  ? '(khaali)'
                  : _eduLine(s.eduRows[i])),
              trailing: locked || busy
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.delete_outline),
                      tooltip: 'Hataayein',
                      onPressed: () {
                        final List<EducationEntryDto> rows =
                            List<EducationEntryDto>.of(s.eduRows)..removeAt(i);
                        context
                            .read<ExtractedReviewCubit>()
                            .setEducationRows(rows);
                      },
                    ),
            ),
          if (!locked && !busy) ...<Widget>[
            const SizedBox(height: 4),
            const Text('Nayi taleem jodein:'),
            const SizedBox(height: 8),
            if (credentials.isNotEmpty)
              DropdownButtonFormField<String>(
                initialValue: _credential,
                decoration:
                    const InputDecoration(labelText: 'Certificate', border: OutlineInputBorder()),
                items: <DropdownMenuItem<String>>[
                  for (final MapEntry<String, String> e in credentials.entries)
                    DropdownMenuItem<String>(value: e.key, child: Text(e.value)),
                ],
                onChanged: (String? v) => setState(() => _credential = v),
              )
            else
              TextField(
                enabled: !locked,
                decoration: const InputDecoration(
                    labelText: 'Certificate (jaise: ITI)',
                    border: OutlineInputBorder()),
                onChanged: (String v) => setState(
                    () => _credential = v.trim().isEmpty ? null : v.trim()),
              ),
            const SizedBox(height: 8),
            TextField(
              controller: _field,
              decoration: const InputDecoration(
                  labelText: 'Vishay / trade', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            if (councils.isNotEmpty)
              DropdownButtonFormField<String>(
                initialValue: _council,
                decoration:
                    const InputDecoration(labelText: 'Board', border: OutlineInputBorder()),
                items: <DropdownMenuItem<String>>[
                  for (final MapEntry<String, String> e in councils.entries)
                    DropdownMenuItem<String>(value: e.key, child: Text(e.value)),
                ],
                onChanged: (String? v) => setState(() => _council = v),
              ),
            const SizedBox(height: 8),
            TextField(
              controller: _institute,
              decoration: const InputDecoration(
                  labelText: 'Sansthaan', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _year,
              keyboardType: TextInputType.number,
              inputFormatters: <TextInputFormatter>[
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(4),
              ],
              decoration: const InputDecoration(
                  labelText: 'Saal', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('Soochi mein jodein'),
              onPressed: () {
                final int? year = int.tryParse(_year.text.trim());
                final EducationEntryDto entry = EducationEntryDto(
                  credential: _credential,
                  field: _field.text.trim().isEmpty
                      ? null
                      : _field.text.trim(),
                  council: _council,
                  year: year,
                  institute: _institute.text.trim().isEmpty
                      ? null
                      : _institute.text.trim(),
                );
                context.read<ExtractedReviewCubit>().setEducationRows(
                    <EducationEntryDto>[...s.eduRows, entry]);
                _field.clear();
                _institute.clear();
                _year.clear();
                setState(() {
                  _credential = null;
                  _council = null;
                });
              },
            ),
          ],
          const SizedBox(height: 8),
          BbButton(
            label: 'Taleem sudhaarein',
            loading: busy,
            onPressed: (!locked && !busy && s.eduDirty)
                ? () => context.read<ExtractedReviewCubit>().submitEducation()
                : null,
          ),
        ],
      ),
    );
  }
}

String _certLine(CertificateEntryDto c) {
  final List<String> parts = <String>[
    c.name.trim(),
    if ((c.issuer ?? '').trim().isNotEmpty) c.issuer!.trim(),
    if (c.year != null) '${c.year}',
  ];
  return parts.join(' · ');
}

class _CertificatesCard extends StatefulWidget {
  const _CertificatesCard({required this.state});

  final ExtractedReviewState state;

  @override
  State<_CertificatesCard> createState() => _CertificatesCardState();
}

class _CertificatesCardState extends State<_CertificatesCard> {
  final TextEditingController _name = TextEditingController();
  final TextEditingController _issuer = TextEditingController();
  final TextEditingController _year = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    _issuer.dispose();
    _year.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ExtractedReviewState s = widget.state;
    final bool busy = s.sendingSection == ExtractedSection.certificates;
    final bool locked = s.correctionsLocked;
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _SectionTitle('Certificate'),
          const SizedBox(height: 8),
          if (s.certRows.isEmpty) const Text('Koi certificate darj nahi.'),
          for (int i = 0; i < s.certRows.length; i++)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(_certLine(s.certRows[i]).isEmpty
                  ? '(khaali)'
                  : _certLine(s.certRows[i])),
              trailing: locked || busy
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.delete_outline),
                      tooltip: 'Hataayein',
                      onPressed: () {
                        final List<CertificateEntryDto> rows =
                            List<CertificateEntryDto>.of(s.certRows)
                              ..removeAt(i);
                        context
                            .read<ExtractedReviewCubit>()
                            .setCertificateRows(rows);
                      },
                    ),
            ),
          if (!locked && !busy) ...<Widget>[
            const SizedBox(height: 4),
            const Text('Naya certificate jodein:'),
            const SizedBox(height: 8),
            TextField(
              controller: _name,
              decoration: const InputDecoration(
                  labelText: 'Naam', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _issuer,
              decoration: const InputDecoration(
                  labelText: 'Kisne diya', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _year,
              keyboardType: TextInputType.number,
              inputFormatters: <TextInputFormatter>[
                FilteringTextInputFormatter.digitsOnly,
                LengthLimitingTextInputFormatter(4),
              ],
              decoration: const InputDecoration(
                  labelText: 'Kis saal mila', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('Soochi mein jodein'),
              onPressed: () {
                final CertificateEntryDto entry = CertificateEntryDto(
                  name: _name.text.trim(),
                  issuer: _issuer.text.trim().isEmpty
                      ? null
                      : _issuer.text.trim(),
                  year: int.tryParse(_year.text.trim()),
                );
                context.read<ExtractedReviewCubit>().setCertificateRows(
                    <CertificateEntryDto>[...s.certRows, entry]);
                _name.clear();
                _issuer.clear();
                _year.clear();
              },
            ),
          ],
          const SizedBox(height: 8),
          BbButton(
            label: 'Certificate sudhaarein',
            loading: busy,
            onPressed: (!locked && !busy && s.certDirty)
                ? () =>
                    context.read<ExtractedReviewCubit>().submitCertificates()
                : null,
          ),
        ],
      ),
    );
  }
}

class _ConfirmCard extends StatelessWidget {
  const _ConfirmCard({required this.state});

  final ExtractedReviewState state;

  @override
  Widget build(BuildContext context) {
    final ExtractedReviewState s = state;
    if (s.confirmed) {
      return KitCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const _SectionTitle('Profile pakki ho gayi'),
            const SizedBox(height: 4),
            Text(
              s.confirmNext == 'trade_form'
                  ? 'Aage form bharein.'
                  : s.confirmNext == 'chat_complete'
                      ? 'Resume banane ke liye aage badhein.'
                      : 'Sudhaari hui profile pakki — resume mein wahi dikhega.',
            ),
          ],
        ),
      );
    }
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const _SectionTitle('Aakhri kadam'),
          const SizedBox(height: 4),
          const Text(
              'Sudhaar ke baad profile pakki karein — pakki profile par hi sahi resume banega.'),
          const SizedBox(height: 8),
          BbButton(
            label: 'Profile pakki karein',
            loading: s.confirming,
            onPressed: (s.review?.profileId == null || s.confirming)
                ? null
                : () => context.read<ExtractedReviewCubit>().confirm(),
          ),
        ],
      ),
    );
  }
}
