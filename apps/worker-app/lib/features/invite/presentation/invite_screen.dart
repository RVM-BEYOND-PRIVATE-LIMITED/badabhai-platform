import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../domain/invite_repository.dart';
import 'cubit/invite_cubit.dart';

/// "Dost ko invite karein" (A3). Creates a referral invite on open and shares the
/// link via the platform sheet. Warm bada-bhai voice; PII-free (only the code).
class InviteScreen extends StatelessWidget {
  const InviteScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<InviteCubit>(
      create: (_) => locator<InviteCubit>()..load(),
      child: const _InviteView(),
    );
  }
}

class _InviteView extends StatelessWidget {
  const _InviteView();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: <Widget>[
          _header(context),
          Expanded(
            child: SafeArea(
              top: false,
              child: BlocBuilder<InviteCubit, InviteState>(
                builder: (BuildContext context, InviteState state) {
                  return switch (state.status) {
                    InviteStatus.loading => const BbStatusView.loading(),
                    InviteStatus.error => BbStatusView(
                        icon: failureReason(state.failure).icon,
                        title: 'Invite link nahi bani.',
                        subtitle: failureReason(state.failure).reason,
                        action: FilledButton(
                          onPressed: () => context.read<InviteCubit>().load(),
                          child: const Text('Dobara try karein'),
                        ),
                      ),
                    InviteStatus.ready => _ready(context, state.link!),
                  };
                },
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Full-bleed blue header with an inline back affordance — kit language
  /// (blue = structure / trust). Replaces the Material app bar so the screen
  /// leads with a proper hero band.
  Widget _header(BuildContext context) {
    return Container(
      width: double.infinity,
      color: AppColors.blue,
      padding: EdgeInsets.fromLTRB(
        AppSpacing.s2,
        MediaQuery.of(context).padding.top + AppSpacing.s1,
        AppSpacing.gutter,
        AppSpacing.s5,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Align(
            alignment: Alignment.centerLeft,
            child: IconButton(
              tooltip: 'Wapas',
              icon: const Icon(Icons.arrow_back, color: AppColors.onBlue),
              onPressed: () => Navigator.of(context).maybePop(),
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
          Padding(
            padding: const EdgeInsets.only(left: AppSpacing.s2),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('Dost ko invite karein',
                    style: AppTypography.display(
                        size: AppTypography.sizeXl,
                        weight: FontWeight.w800,
                        color: AppColors.onBlue)),
                const SizedBox(height: 2),
                Text('Referral link share karein',
                    style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        color: AppColors.onBlueMuted)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _ready(BuildContext context, InviteLink link) {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.gutter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const SizedBox(height: AppSpacing.s4),
          Center(
            child: Container(
              width: 96,
              height: 96,
              alignment: Alignment.center,
              decoration: const BoxDecoration(
                color: AppColors.saffron50,
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.group_add_rounded,
                  size: 48, color: AppColors.saffronDeep),
            ),
          ),
          const SizedBox(height: AppSpacing.s5),
          Text(
            'Apne dost ko BadaBhai par bulao',
            textAlign: TextAlign.center,
            style: AppTypography.display(
                size: AppTypography.sizeXl, weight: FontWeight.w800),
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            'Woh bhi apna profile banakar factory jobs pa sakte hain — no test, '
            'bas baat-cheet.',
            textAlign: TextAlign.center,
            style: AppTypography.body(color: AppColors.textMuted),
          ),
          const SizedBox(height: AppSpacing.s5),
          _linkChip(context, link),
          const Spacer(),
          // The ONE haldi CTA (kit: a single primary per screen) — opens the OS
          // share sheet with the referral link.
          BbButton(
            label: 'Link share karein',
            block: true,
            iconLeft: Icons.share_rounded,
            onPressed: () => context.read<InviteCubit>().shareInvite(),
          ),
          const SizedBox(height: AppSpacing.s2),
          // WhatsApp is the worker's default share target — GREEN is the kit's
          // WhatsApp/success colour. This opens WhatsApp DIRECTLY (wa.me contact
          // picker, message pre-filled); it used to call the same generic sheet
          // as the button above, so the label was a promise the code did not
          // keep. Falls back to the sheet when WhatsApp cannot be opened.
          BbButton(
            label: 'WhatsApp pe bhejein',
            block: true,
            variant: BbButtonVariant.success,
            iconLeft: Icons.chat_rounded,
            onPressed: () => context.read<InviteCubit>().shareInviteOnWhatsApp(),
          ),
          const SizedBox(height: AppSpacing.s3),
        ],
      ),
    );
  }

  Widget _linkChip(BuildContext context, InviteLink link) {
    return Container(
      padding: const EdgeInsets.only(
          left: AppSpacing.s4, right: AppSpacing.s2, top: AppSpacing.s1, bottom: AppSpacing.s1),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Row(
        children: <Widget>[
          const Icon(Icons.link_rounded, size: 20, color: AppColors.textMuted),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              link.url,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.mono(size: AppTypography.sizeSm),
            ),
          ),
          // The link was DISPLAYED but not copyable — a worker who wanted to
          // paste it into an app the share sheet does not list had no way to
          // get it. Ellipsised text cannot be selected out either.
          IconButton(
            icon: const Icon(Icons.copy_rounded, size: 20),
            color: AppColors.textMuted,
            tooltip: 'Link copy karein',
            onPressed: () => _copyLink(context),
          ),
        ],
      ),
    );
  }

  Future<void> _copyLink(BuildContext context) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final bool copied = await context.read<InviteCubit>().copyInviteLink();
    // The cubit reports whether the clipboard actually took the text; a refused
    // clipboard must not be confirmed as "Copied".
    messenger.showSnackBar(
      SnackBar(
        content: Text(copied ? 'Link copy ho gaya' : 'Link copy nahi ho paya'),
        duration: const Duration(seconds: 2),
      ),
    );
  }
}
