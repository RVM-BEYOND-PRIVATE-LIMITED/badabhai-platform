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
import '../../../core/widgets/bb_toast.dart';

/// Post a job — role-branched on [AppSession.role].
///
///  - COMPANY: `POST /payer/job-postings` (201 draft; publish it later from
///    My-jobs) accepts `org_label`, `role_title`, optional `location_label`,
///    optional free-text `description`, and EXACTLY ONE of
///    `vacancy_band | vacancies`. It has NO trade/pay/experience/skills columns,
///    so #357 folds those payer-entered details into `description` — see
///    [_PostJobScreenState._companyDescription]. Nothing is prefilled: every
///    free-text input starts empty (#357).
///  - AGENCY: sends the faceless demand attributes the agent route accepts —
///    `trade_key`, `title`, `city`, optional `area`, `pay_min`/`pay_max`,
///    `min_experience_years`/`max_experience_years`, `needed_by` — to
///    `POST /payer/agency/jobs` (201 → live `open`; refetch My-jobs). Unlike the
///    company route, agency DOES accept trade/pay/experience as typed columns.
///    NEVER an employer name or worker identity (no such field on this contract).
class PostJobScreen extends StatefulWidget {
  const PostJobScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  State<PostJobScreen> createState() => _PostJobScreenState();
}

class _PostJobScreenState extends State<PostJobScreen> {
  late final TextEditingController _org;

  // #357 — every free-text input starts EMPTY. These used to ship fabricated
  // demo values ('CNC Setter' / 'Pimpri, Pune' / 'Pune' / 'Chakan') that the
  // submit path sent VERBATIM to the real create routes, so a payer who tapped
  // straight through published a posting they never typed.
  final TextEditingController _title = TextEditingController();
  final TextEditingController _location = TextEditingController();

  // --- Coarse pay / experience bands — used by BOTH branches ----------------
  // The session role is locked at login, so only one branch is ever mounted and
  // these four controllers are shared. Agency sends them as typed columns;
  // company folds them into `description` (#357 — they used to be two free-text
  // fields, '₹22k–28k' / '3+ yrs', that were rendered and then silently dropped).
  final TextEditingController _payMin = TextEditingController();
  final TextEditingController _payMax = TextEditingController();
  final TextEditingController _expMin = TextEditingController();
  final TextEditingController _expMax = TextEditingController();

  // --- Agency-only inputs (`POST /payer/agency/jobs`) ------------------------
  final TextEditingController _city = TextEditingController();
  final TextEditingController _area = TextEditingController();

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

  /// Server bound on skill phrases (`skillsInput`: <=10 phrases, 1..80 chars).
  /// Mirrored here so the chip row cannot outgrow what the contract allows.
  static const int _maxSkills = 10;
  static const int _maxSkillChars = 80;

  /// Company trade — null until the payer picks one (#357: a default of
  /// 'CNC Setter' would put a trade the payer never chose into `description`).
  String? _trade;
  String _band = '2-5';
  // Agency `trade_key` enum + coarse `needed_by` timing (server-accepted values).
  String _tradeKey = kAgencyTradeKeys.first;
  String _neededBy = kAgencyNeededBy.first;
  // #357 — starts empty; '+ Add skill' prompts for a real phrase instead of
  // inserting the literal placeholder 'Skill N'.
  final List<String> _skills = <String>[];
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

  /// Whole-rupee formatter with thousands grouping — "₹22,000". The grouping is
  /// load-bearing beyond the DS money rule (#357): it breaks the digit run, so a
  /// formatted amount can never trip the server's `looksLikePii` phone heuristic
  /// (>=7 consecutive digits) when it rides inside `description`.
  static String _formatInr(int value) {
    final String digits = value.abs().toString();
    final StringBuffer out = StringBuffer('₹');
    for (int i = 0; i < digits.length; i++) {
      if (i != 0 && (digits.length - i) % 3 == 0) out.write(',');
      out.write(digits[i]);
    }
    return out.toString();
  }

  /// "₹22,000–₹28,000" | "₹22,000+" | "up to ₹28,000" | null when neither end is
  /// set. Mirrors `AgencyJobView.payRangeLabel` so both branches read alike.
  static String? _payLabel(int? lo, int? hi) {
    if (lo == null && hi == null) return null;
    if (lo != null && hi != null) return '${_formatInr(lo)}–${_formatInr(hi)}';
    if (lo != null) return '${_formatInr(lo)}+';
    return 'up to ${_formatInr(hi!)}';
  }

  /// "2–6 yrs" | "2+ yrs" | "up to 6 yrs" | null when neither end is set.
  static String? _expLabel(int? lo, int? hi) {
    if (lo == null && hi == null) return null;
    if (lo != null && hi != null) return '$lo–$hi yrs';
    if (lo != null) return '$lo+ yrs';
    return 'up to $hi yrs';
  }

  // #357 — client mirror of the server's `looksLikePii` (packages/validators):
  // email shape, or >=7 consecutive digits once common phone separators are
  // stripped. Skill phrases are payer free text that rides the wire inside the
  // PII-screened `description`, so we fail closed AT ENTRY with an honest
  // message rather than let the server 400 the whole post (CLAUDE.md §2).
  static final RegExp _emailLike = RegExp(r'[^\s@]+@[^\s@]+\.[^\s@]+');
  static final RegExp _phoneSeparators = RegExp(r'[\s().+-]');
  static final RegExp _phoneDigitRun = RegExp(r'\d{7,}');

  static bool _looksLikePii(String s) =>
      _emailLike.hasMatch(s) ||
      _phoneDigitRun.hasMatch(s.replaceAll(_phoneSeparators, ''));

  /// Shared min/max ordering check for the coarse bands — returns an honest
  /// message, or null when the bands are fine. The server 400s these too.
  String? _bandOrderError(int? payMin, int? payMax, int? expMin, int? expMax) {
    if (payMin != null && payMax != null && payMax < payMin) {
      return 'Max pay must be at least the min.';
    }
    if (expMin != null && expMax != null && expMax < expMin) {
      return 'Max experience must be at least the min.';
    }
    return null;
  }

  /// #357 — the company create contract has NO trade/pay/experience/skills
  /// columns; its one free-text field is `description`. These inputs used to be
  /// rendered and then silently discarded, so a payer who carefully set a salary
  /// and five skills posted a job carrying none of it. We now fold exactly what
  /// the payer entered into a labelled description block, so it actually lands
  /// on the posting. Nothing is invented: an untouched form sends NO description
  /// (null), never a filler string.
  String? _companyDescription() {
    final List<String> lines = <String>[];
    final String? trade = _trade;
    if (trade != null) lines.add('Trade: $trade');
    final String? pay =
        _payLabel(_intOrNull(_payMin.text), _intOrNull(_payMax.text));
    if (pay != null) lines.add('Monthly pay: $pay');
    final String? exp =
        _expLabel(_intOrNull(_expMin.text), _intOrNull(_expMax.text));
    if (exp != null) lines.add('Experience: $exp');
    if (_skills.isNotEmpty) lines.add('Key skills: ${_skills.join(', ')}');
    return lines.isEmpty ? null : lines.join('\n');
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

    final String? bandError = _bandOrderError(
      _intOrNull(_payMin.text),
      _intOrNull(_payMax.text),
      _intOrNull(_expMin.text),
      _intOrNull(_expMax.text),
    );
    if (bandError != null) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: bandError,
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
        // #357 — carries the trade/pay/experience/skills the payer entered.
        description: _companyDescription(),
        vacancyBand: _band,
      );
      if (!mounted) return;
      showBbToast(
        context,
        title: 'Job posted',
        message: 'Saved as a draft — publish it from My jobs.',
      );
      widget.onBack();
    } catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      _showPostFailure(error);
    }
  }

  /// Name the real reason where we know it: a 400 on this route means the server
  /// rejected the details themselves (most often contact details in the folded
  /// description), which "check your connection" would misdescribe.
  void _showPostFailure(Object error) {
    final bool rejected = error is PayerApiException && error.isBadRequest;
    showBbToast(
      context,
      title: 'Could not post',
      message: rejected
          ? 'The server rejected these details. Remove any phone number or '
              'email address from the job details.'
          : 'Something went wrong. Please try again.',
      icon: Icons.info_outline,
    );
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
    final String? bandError =
        _bandOrderError(payMin, payMax, expMin, expMax);
    if (bandError != null) {
      showBbToast(
        context,
        title: 'Check the bands',
        message: bandError,
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
    } catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      _showPostFailure(error);
    }
  }

  /// #357 — '+ Add skill' used to insert the literal placeholder 'Skill N', so
  /// the chip row was decorative. It now prompts for the real phrase, bounded to
  /// the server's `skillsInput` limits and screened for contact details.
  Future<void> _addSkill() async {
    final String? entered = await showDialog<String>(
      context: context,
      builder: (BuildContext _) => const _AddSkillDialog(),
    );

    if (!mounted || entered == null || entered.isEmpty) return;
    if (entered.length > _maxSkillChars) {
      showBbToast(
        context,
        title: 'Too long',
        message: 'Keep a skill under $_maxSkillChars characters.',
        icon: Icons.info_outline,
      );
      return;
    }
    if (_looksLikePii(entered)) {
      showBbToast(
        context,
        title: 'Not a skill',
        message: 'Leave phone numbers and email addresses out of a posting.',
        icon: Icons.info_outline,
      );
      return;
    }
    if (_skills.contains(entered)) return;
    setState(() => _skills.add(entered));
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

  /// COMPANY posting inputs. #357: every input here now reaches
  /// `POST /payer/job-postings` — org/title/location/vacancy band as their own
  /// columns, and trade + pay + experience + skills folded into the free-text
  /// `description` (see [_companyDescription]), because that route has no typed
  /// column for them. Nothing on this form is prefilled and nothing is dropped.
  List<Widget> _companyFields() => <Widget>[
        BbField(label: 'Company / org name', controller: _org),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Job title',
          controller: _title,
          hint: 'e.g. CNC Setter',
        ),
        const SizedBox(height: AppSpacing.s4),
        // Null until picked — a preselected trade would land in `description`
        // without the payer ever choosing it (#357).
        BbSelect<String?>(
          label: 'Trade (optional)',
          value: _trade,
          items: <String?>[null, ..._trades],
          labelOf: (String? t) => t ?? 'Not specified',
          onChanged: (String? v) => setState(() => _trade = v),
        ),
        const SizedBox(height: AppSpacing.s4),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: BbField(
                label: 'Location',
                controller: _location,
                hint: 'optional',
              ),
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
        // Whole rupees, not free text: the entered band is formatted with
        // thousands grouping (DS money rule) before it rides `description`.
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
        Text(
          'Key skills',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
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
            // Hidden at the server's cap rather than letting the payer add a
            // phrase the contract would reject.
            if (_skills.length < _maxSkills)
              BbChip(
                label: '+ Add skill',
                // ignore: discarded_futures — fire-and-forget dialog, like the
                // other sheet openers on this surface.
                onTap: _addSkill,
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
        // #357 — this was a live-looking 'Boost this posting' toggle that the
        // create call never read. Boost really is a separate paid action
        // (`POST /payer/job-postings/:id/boost`) on an existing posting, so we
        // say where it lives instead of faking a switch here.
        Text(
          'Boost and applicant plans are bought from My jobs once this posting '
          'is published.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
            height: 1.45,
          ),
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
              // #357 — was prefilled 'Pune' (and area 'Chakan'); the agency
              // route is just as real, so these start empty too.
              child: BbField(
                label: 'City',
                controller: _city,
                hint: 'e.g. Pune',
              ),
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

/// #357 — the '+ Add skill' prompt. A widget (not an inline `AlertDialog`) so it
/// OWNS its [TextEditingController]: disposing one alongside the awaited
/// `showDialog` future tears it down while the route is still animating out, and
/// the still-mounted [TextField] then throws "used after being disposed".
/// Pops the trimmed phrase, or null on cancel.
class _AddSkillDialog extends StatefulWidget {
  const _AddSkillDialog();

  @override
  State<_AddSkillDialog> createState() => _AddSkillDialogState();
}

class _AddSkillDialogState extends State<_AddSkillDialog> {
  final TextEditingController _field = TextEditingController();

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  void _submit() => Navigator.of(context).pop(_field.text.trim());

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surfaceCard,
      title: Text(
        'Add a skill',
        style: AppTypography.display(
          size: AppTypography.sizeMd,
          weight: FontWeight.w800,
        ),
      ),
      content: BbField(
        controller: _field,
        hint: 'e.g. Fanuc, VMC setting',
        fieldKey: const Key('add-skill-field'),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(onPressed: _submit, child: const Text('Add')),
      ],
    );
  }
}
