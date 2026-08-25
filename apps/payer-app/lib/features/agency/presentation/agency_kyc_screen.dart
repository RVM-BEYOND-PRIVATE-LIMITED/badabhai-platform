import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_icon_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/agency_kyc_cubit.dart';

/// Agency KYC — submit / view the agent's masked payout KYC (`GET /POST
/// /payer/agency/kyc`). AGENT-only AND FLAG-GATED: a neutral 404 shows an honest
/// "not available yet"; a company session's 403 shows "agency accounts only".
///
/// SHARED-DEVICE HYGIENE: the raw PAN / bank / IFSC are typed here but never
/// stored locally — they go straight to the POST and the fields are CLEARED on a
/// successful submit. The screen only ever DISPLAYS the server's masked last-4.
class AgencyKycScreen extends StatelessWidget {
  const AgencyKycScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AgencyKycCubit>(
      create: (_) => locator<AgencyKycCubit>()..load(),
      child: const _KycView(),
    );
  }
}

class _KycView extends StatelessWidget {
  const _KycView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.surfacePage,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _Header(onBack: () => Navigator.of(context).pop()),
            Expanded(
              child: BlocBuilder<AgencyKycCubit, AgencyKycState>(
                builder: (BuildContext context, AgencyKycState state) =>
                    _body(context, state),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, AgencyKycState state) {
    void reload() => context.read<AgencyKycCubit>().load();

    switch (state.status) {
      case AgencyKycStatus.initial:
      case AgencyKycStatus.loading:
        return const BbStatusView.loading(caption: 'Loading…');
      case AgencyKycStatus.unavailable:
        return const BbStatusView(
          icon: Icons.schedule,
          title: 'Not available yet',
          subtitle: 'Payout KYC is coming soon. There is nothing to fill in '
              'right now.',
        );
      case AgencyKycStatus.forbidden:
        return const BbStatusView(
          icon: Icons.lock_outline,
          title: 'Agency accounts only',
          subtitle: 'KYC for payouts is only available on agency (recruiter) '
              'accounts.',
        );
      case AgencyKycStatus.error:
        return BbStatusView(
          icon: Icons.wifi_off,
          title: 'Could not load',
          subtitle: 'Please check your connection and try again.',
          action: BbButton(label: 'Retry', onPressed: reload),
        );
      case AgencyKycStatus.ready:
        return _KycForm(kyc: state.kyc, submitting: state.submitting);
    }
  }
}

/// The masked status card + the submit/replace form.
class _KycForm extends StatefulWidget {
  const _KycForm({required this.kyc, required this.submitting});

  final AgencyKycView? kyc;
  final bool submitting;

  @override
  State<_KycForm> createState() => _KycFormState();
}

class _KycFormState extends State<_KycForm> {
  final TextEditingController _name = TextEditingController();
  final TextEditingController _pan = TextEditingController();
  final TextEditingController _bank = TextEditingController();
  final TextEditingController _ifsc = TextEditingController();

  @override
  void initState() {
    super.initState();
    // Live-validate so the submit button reflects a well-formed form.
    for (final TextEditingController c in <TextEditingController>[
      _name,
      _pan,
      _bank,
      _ifsc,
    ]) {
      c.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    _name.dispose();
    _pan.dispose();
    _bank.dispose();
    _ifsc.dispose();
    super.dispose();
  }

  // Client-side format mirrors the server regex — fast feedback only; the server
  // is the authority (and re-validates + rejects an obviously-bad value).
  static final RegExp _panRe = RegExp(r'^[A-Z]{5}[0-9]{4}[A-Z]$');
  static final RegExp _bankRe = RegExp(r'^[0-9]{9,18}$');
  static final RegExp _ifscRe = RegExp(r'^[A-Z]{4}0[A-Z0-9]{6}$');

  bool get _nameOk => _name.text.trim().length >= 2;
  bool get _panOk => _panRe.hasMatch(_pan.text.trim().toUpperCase());
  bool get _bankOk => _bankRe.hasMatch(_bank.text.trim());
  bool get _ifscOk => _ifscRe.hasMatch(_ifsc.text.trim().toUpperCase());
  bool get _formOk => _nameOk && _panOk && _bankOk && _ifscOk;

  Future<void> _submit() async {
    final AgencyKycCubit cubit = context.read<AgencyKycCubit>();
    final KycSubmitResult result = await cubit.submit(
      pan: _pan.text.trim().toUpperCase(),
      bankAccount: _bank.text.trim(),
      ifsc: _ifsc.text.trim().toUpperCase(),
      accountHolderName: _name.text.trim(),
    );
    if (!mounted) return;
    if (result.success) {
      // Shared-device hygiene: never leave financial PII in the fields.
      _name.clear();
      _pan.clear();
      _bank.clear();
      _ifsc.clear();
    }
    showBbToast(
      context,
      title: result.success ? 'Submitted' : 'Not now',
      message: result.message,
      icon: result.success ? Icons.check_circle : Icons.info_outline,
    );
  }

  @override
  Widget build(BuildContext context) {
    final AgencyKycView? kyc = widget.kyc;
    return ListView(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s6,
      ),
      children: <Widget>[
        if (kyc != null && !kyc.isNotSubmitted) ...<Widget>[
          _StatusCard(kyc: kyc),
          const SizedBox(height: AppSpacing.s5),
        ],
        Text(
          kyc != null && !kyc.isNotSubmitted
              ? 'Update your details'
              : 'Add your payout details',
          style: AppTypography.display(
            size: AppTypography.sizeBase,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s1),
        Text(
          'We keep these encrypted and only use them to pay you. You will only '
          'ever see the last 4 digits after saving.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
            height: 1.45,
          ),
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Account holder name',
          controller: _name,
          hint: 'As printed on your bank account',
          keyboardType: TextInputType.name,
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'PAN',
          controller: _pan,
          hint: 'ABCDE1234F',
          mono: true,
          keyboardType: TextInputType.text,
          inputFormatters: <TextInputFormatter>[
            UpperCaseTextFormatter(),
            LengthLimitingTextInputFormatter(10),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'Bank account number',
          controller: _bank,
          hint: '9 to 18 digits',
          mono: true,
          keyboardType: TextInputType.number,
          inputFormatters: <TextInputFormatter>[
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(18),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        BbField(
          label: 'IFSC',
          controller: _ifsc,
          hint: 'HDFC0001234',
          mono: true,
          keyboardType: TextInputType.text,
          inputFormatters: <TextInputFormatter>[
            UpperCaseTextFormatter(),
            LengthLimitingTextInputFormatter(11),
          ],
        ),
        const SizedBox(height: AppSpacing.s5),
        BbButton(
          label: kyc != null && !kyc.isNotSubmitted ? 'Save changes' : 'Submit',
          block: true,
          loading: widget.submitting,
          // Disabled (a no-op) until the form is well-formed — cheaper than a
          // round-trip to learn the PAN was malformed.
          onPressed: _formOk ? _submit : () {},
        ),
      ],
    );
  }
}

/// A digits+letters upper-casing formatter (PAN/IFSC are stored uppercase).
class UpperCaseTextFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    return TextEditingValue(
      text: newValue.text.toUpperCase(),
      selection: newValue.selection,
    );
  }
}

/// The current masked status — last-4 only, plus a humanized reject reason.
class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.kyc});

  final AgencyKycView kyc;

  (String, BbBadgeTone) get _pill => switch (kyc.status) {
        'verified' => ('Verified', BbBadgeTone.success),
        'pending' => ('In review', BbBadgeTone.warning),
        'rejected' => ('Action needed', BbBadgeTone.danger),
        _ => ('Not started', BbBadgeTone.neutral),
      };

  /// Humanize the bounded reject-reason CODE (never the raw enum on-screen).
  static String _rejectText(String? reason) {
    switch (reason) {
      case 'invalid_pan':
        return 'The PAN could not be verified. Please re-check and resubmit.';
      case 'invalid_bank':
        return 'The bank account could not be verified. Please re-check and '
            'resubmit.';
      case 'name_mismatch':
        return 'The name did not match the bank account. Please re-check and '
            'resubmit.';
      case 'duplicate':
        return 'These details are already in use. Please use your own PAN and '
            'account.';
      default:
        return 'We could not verify these details. Please re-check and '
            'resubmit.';
    }
  }

  @override
  Widget build(BuildContext context) {
    final (String label, BbBadgeTone tone) = _pill;
    return BbCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  'Your KYC',
                  style: AppTypography.display(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                  ),
                ),
              ),
              BbBadge(label, tone: tone),
            ],
          ),
          if (kyc.panLast4 != null || kyc.bankLast4 != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            if (kyc.panLast4 != null)
              _MaskedRow(label: 'PAN', last4: kyc.panLast4!),
            if (kyc.bankLast4 != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s2),
              _MaskedRow(label: 'Bank account', last4: kyc.bankLast4!),
            ],
          ],
          if (kyc.isRejected) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            Text(
              _rejectText(kyc.rejectReason),
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.danger,
                height: 1.45,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _MaskedRow extends StatelessWidget {
  const _MaskedRow({required this.label, required this.last4});

  final String label;
  final String last4;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
        ),
        Text(
          '•••• $last4',
          style: AppTypography.mono(
            size: AppTypography.sizeBase,
            weight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onBack});

  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        AppSpacing.s2,
        AppSpacing.gutter,
        AppSpacing.s2,
      ),
      child: Row(
        children: <Widget>[
          BbIconButton(
            icon: Icons.arrow_back,
            semanticLabel: 'Back',
            onPressed: onBack,
          ),
          const SizedBox(width: AppSpacing.s3),
          Text(
            'KYC details',
            style: AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}
