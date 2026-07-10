import 'package:flutter/material.dart';

import '../../../core/data/models.dart';
import '../../../core/data/payer_api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_switch_row.dart';
import '../../../core/widgets/bb_toast.dart';

/// Post a job — role-branched on [AppSession.role].
///
///  - COMPANY: sends ONLY the fields the company posting route accepts —
///    `org_label`, `role_title`, optional `location_label`, and EXACTLY ONE of
///    `vacancy_band | vacancies` — to `POST /payer/job-postings` (201 draft;
///    publish it later from My-jobs). The kit's extra inputs (trade / salary /
///    experience / key skills / boost toggle) are NOT part of that contract, so
///    they are kept as UI-only affordances and are NEVER sent.
///  - AGENCY: sends the faceless demand attributes the agent route accepts —
///    `trade_key`, `title`, `city`, optional `area`, `pay_min`/`pay_max`,
///    `min_experience_years`/`max_experience_years`, `needed_by` — to
///    `POST /payer/agency/jobs` (201 → live `open`; refetch My-jobs). Unlike the
///    company route, agency DOES accept trade/pay/experience. NEVER an employer
///    name or worker identity (no such field exists on this contract).
class PostJobScreen extends StatefulWidget {
  const PostJobScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  State<PostJobScreen> createState() => _PostJobScreenState();
}

class _PostJobScreenState extends State<PostJobScreen> {
  late final TextEditingController _org;
  final TextEditingController _title =
      TextEditingController(text: 'CNC Setter');
  final TextEditingController _location =
      TextEditingController(text: 'Pimpri, Pune');
  // UI-only — NOT sent to the company posting API (see class doc).
  final TextEditingController _salary =
      TextEditingController(text: '₹22k–28k');
  final TextEditingController _experience =
      TextEditingController(text: '3+ yrs');

  // --- Agency-only inputs (`POST /payer/agency/jobs`) ------------------------
  final TextEditingController _city = TextEditingController(text: 'Pune');
  final TextEditingController _area = TextEditingController(text: 'Chakan');
  final TextEditingController _payMin = TextEditingController();
  final TextEditingController _payMax = TextEditingController();
  final TextEditingController _expMin = TextEditingController();
  final TextEditingController _expMax = TextEditingController();

  static const List<String> _trades = <String>[
    'CNC Setter',
    'VMC Setter',
    'CNC Operator',
    'Quality Inspector',
    'Welder / Fabricator',
    'Fitter',
  ];

  /// The server's `vacancy_band` enum — exact values the route accepts.
  static const List<String> _bands = <String>['1', '2-5', '6-10', '11-25', '25+'];

  String _trade = 'CNC Setter';
  String _band = '2-5';
  // Agency `trade_key` enum + coarse `needed_by` timing (server-accepted values).
  String _tradeKey = kAgencyTradeKeys.first;
  String _neededBy = kAgencyNeededBy.first;
  final List<String> _skills = <String>['Fanuc', 'VMC setting'];
  bool _boost = false;
  bool _submitting = false;

  bool get _isAgency =>
      locator<AppSessionCubit>().state?.isAgency ?? false;

  @override
  void initState() {
    super.initState();
    // org_label is required by the company route; default it to the signed-in
    // account name (editable) so the posting is attributed to the right org.
    final String orgName =
        locator<AppSessionCubit>().state?.account.name ?? '';
    _org = TextEditingController(text: orgName);
  }

  @override
  void dispose() {
    _org.dispose();
    _title.dispose();
    _location.dispose();
    _salary.dispose();
    _experience.dispose();
    _city.dispose();
    _area.dispose();
    _payMin.dispose();
    _payMax.dispose();
    _expMin.dispose();
    _expMax.dispose();
    super.dispose();
  }

  /// A trimmed whole-number field → int, or null when empty/invalid (an optional
  /// coarse band).
  static int? _intOrNull(String raw) {
    final String t = raw.trim();
    if (t.isEmpty) return null;
    return int.tryParse(t);
  }

  Future<void> _submit() async {
    if (_isAgency) {
      await _submitAgency();
      return;
    }

    final String org = _org.text.trim();
    final String title = _title.text.trim();
    if (org.isEmpty || title.isEmpty) {
      showBbToast(
        context,
        title: 'Add the basics',
        message: 'Company name and job title are needed.',
        icon: Icons.info_outline,
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final String location = _location.text.trim();
      await locator<PayerApiClient>().createCompanyJob(
        orgLabel: org,
        roleTitle: title,
        locationLabel: location.isEmpty ? null : location,
        vacancyBand: _band,
      );
      if (!mounted) return;
      showBbToast(
        context,
        title: 'Job posted',
        message: 'Saved as a draft — publish it from My jobs.',
      );
      widget.onBack();
    } catch (_) {
      if (!mounted) return;
      setState(() => _submitting = false);
      showBbToast(
        context,
        title: 'Could not post',
        message: 'Something went wrong. Please try again.',
        icon: Icons.info_outline,
      );
    }
  }

  /// AGENCY create — the faceless demand contract (`POST /payer/agency/jobs`).
  /// Sends `trade_key`/`title`/`city` (+ optional coarse `area`/pay/experience
  /// bands + `needed_by`). On success → toast + back to My-jobs (which refetches
  /// agency jobs). NEVER an org/employer name (no such field on this route).
  Future<void> _submitAgency() async {
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
    // Client-side ordering check for an honest message (the server also 400s).
    if (payMin != null && payMax != null && payMax < payMin) {
      showBbToast(
        context,
        title: 'Check the pay band',
        message: 'Max pay must be at least the min.',
        icon: Icons.info_outline,
      );
      return;
    }
    if (expMin != null && expMax != null && expMax < expMin) {
      showBbToast(
        context,
        title: 'Check the experience band',
        message: 'Max experience must be at least the min.',
        icon: Icons.info_outline,
      );
      return;
    }

    setState(() => _submitting = true);
    try {
      final String area = _area.text.trim();
      await locator<PayerApiClient>().createAgencyJob(
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
        title: 'Job posted',
        message: 'Live now — see it under My jobs.',
      );
      widget.onBack();
    } catch (_) {
      if (!mounted) return;
      setState(() => _submitting = false);
      showBbToast(
        context,
        title: 'Could not post',
        message: 'Something went wrong. Please try again.',
        icon: Icons.info_outline,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
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
              onPressed: widget.onBack,
            ),
            const SizedBox(width: AppSpacing.s3),
            Text(
              'Post a job',
              style: AppTypography.display(
                size: AppTypography.sizeLg,
                weight: FontWeight.w800,
              ),
            ),
            const Spacer(),
            const BbBadge('Free', tone: BbBadgeTone.success),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        // Branch on the locked session role: the agency posts to a DIFFERENT
        // (faceless demand) contract that DOES accept trade/pay/experience.
        ...(_isAgency ? _agencyFields() : _companyFields()),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: 'Post job',
          iconLeft: Icons.send,
          block: true,
          loading: _submitting,
          onPressed: _submit,
        ),
      ],
    );
  }

  /// COMPANY posting inputs. The org name + title + vacancy band are the only
  /// fields sent to `POST /payer/job-postings`; trade/salary/experience/skills/
  /// boost are UI-only affordances (see class doc) and never leave the screen.
  List<Widget> _companyFields() => <Widget>[
        BbField(label: 'Company / org name', controller: _org),
        const SizedBox(height: AppSpacing.s4),
        BbField(label: 'Job title', controller: _title),
        const SizedBox(height: AppSpacing.s4),
        // UI-only — the company route has no `trade` field.
        BbSelect<String>(
          label: 'Trade',
          value: _trade,
          items: _trades,
          labelOf: (String t) => t,
          onChanged: (String? v) => setState(() => _trade = v ?? _trade),
        ),
        const SizedBox(height: AppSpacing.s4),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: BbField(label: 'Location', controller: _location),
            ),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: BbSelect<String>(
                label: 'Vacancies',
                value: _band,
                items: _bands,
                labelOf: (String b) => b,
                onChanged: (String? v) => setState(() => _band = v ?? _band),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        // UI-only — salary/experience are not part of the company posting API.
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: BbField(label: 'Monthly salary', controller: _salary),
            ),
            const SizedBox(width: AppSpacing.s3),
            Expanded(
              child: BbField(label: 'Experience', controller: _experience),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        Text(
          'Key skills',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        // UI-only — skills are not sent to the company posting API.
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: <Widget>[
            for (final String skill in _skills)
              BbChip(
                label: skill,
                selected: true,
                icon: Icons.close,
                onTap: () => setState(() => _skills.remove(skill)),
              ),
            BbChip(
              label: '+ Add skill',
              onTap: () =>
                  setState(() => _skills.add('Skill ${_skills.length + 1}')),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        Container(
          padding: const EdgeInsets.all(AppSpacing.s3),
          decoration: BoxDecoration(
            color: AppColors.successTint,
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: AppColors.success, width: 1.5),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Icon(Icons.verified_user,
                  size: 22, color: AppColors.green700),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: RichText(
                  text: TextSpan(
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.green700,
                      height: 1.45,
                    ),
                    children: <InlineSpan>[
                      const TextSpan(
                        text: 'Confirm this is a real, open role. ',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      const TextSpan(
                        text: 'We verify before workers see it — ghost jobs '
                            'waste swipes. ',
                      ),
                      const TextSpan(
                        text: "You'll get a Verified job badge once approved. "
                            'Posting is free.',
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        // UI-only — boost is a paid action on My-jobs, not a create field.
        BbSwitchRow(
          title: 'Boost this posting',
          suffix: '— more reach, within relevance',
          value: _boost,
          onChanged: (bool v) => setState(() => _boost = v),
        ),
      ];

  /// AGENCY posting inputs — every field here IS sent to `POST /payer/agency/
  /// jobs` (trade_key/title/city + optional coarse area/pay/experience bands +
  /// needed_by). No org/employer name — that is not a demand attribute.
  List<Widget> _agencyFields() => <Widget>[
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
              child: BbField(
                label: 'Area (optional)',
                controller: _area,
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
        const SizedBox(height: AppSpacing.s4),
        Container(
          padding: const EdgeInsets.all(AppSpacing.s3),
          decoration: BoxDecoration(
            color: AppColors.infoTint,
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: AppColors.teal500, width: 1.5),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Icon(Icons.info_outline, size: 22, color: AppColors.teal700),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: Text(
                  'Pay & experience are optional bands — they only help us match '
                  'the right workers. Posting is free.',
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.teal700,
                    height: 1.45,
                  ),
                ),
              ),
            ],
          ),
        ),
      ];
}
