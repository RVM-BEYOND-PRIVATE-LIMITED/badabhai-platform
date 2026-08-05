import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../router.dart';
import 'cubit/name_cubit.dart';

/// "Your name" onboarding step — placed AFTER consent, before chat profiling.
/// Captures the worker's real name ONCE, explicitly, with a clear purpose ("for
/// your resume"). The name goes straight to the API (encrypted at rest) and is
/// never asked for again in the chat flow, which stays identity-free.
class NameScreen extends StatelessWidget {
  const NameScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<NameCubit>(
      create: (_) => locator<NameCubit>(),
      child: const _NameView(),
    );
  }
}

class _NameView extends StatefulWidget {
  const _NameView();

  @override
  State<_NameView> createState() => _NameViewState();
}

class _NameViewState extends State<_NameView> {
  final TextEditingController _controller = TextEditingController();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final bool has = _controller.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit(BuildContext context, NameState state) {
    if (_hasText && !state.isSubmitting) {
      context.read<NameCubit>().submit(_controller.text);
    }
  }

  @override
  Widget build(BuildContext context) {
    return BlocConsumer<NameCubit, NameState>(
      listenWhen: (NameState p, NameState c) => p.status != c.status,
      listener: (BuildContext context, NameState state) {
        if (state.status == NameStatus.success) {
          // #381 — go, NOT push. Pushing left the SUBMITTED name screen alive
          // underneath, so system back from the profiling chat dropped the
          // worker onto a name they had already saved, inviting a duplicate
          // submit. Onboarding is a one-way sequence; each completed step
          // replaces the last rather than stacking. (ProfilePreviewScreen
          // already does the same with go(Routes.building).)
          context.go(Routes.chatProfiling);
        } else if (state.status == NameStatus.failed) {
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(
              const SnackBar(
                content: Text('Naam save nahi hua. Dobara koshish karein.'),
              ),
            );
        }
      },
      builder: (BuildContext context, NameState state) {
        // Kit onboarding pattern (screens 02/06): a full-bleed deep-blue header
        // band (haldi title + muted subtitle) over a padded body with a single
        // labelled field and the primary CTA.
        return Scaffold(
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: double.infinity,
                color: AppColors.blue,
                padding: EdgeInsets.fromLTRB(
                  AppSpacing.gutter,
                  MediaQuery.of(context).padding.top + AppSpacing.s5,
                  AppSpacing.gutter,
                  AppSpacing.s5,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text('Aapka naam?',
                        style: AppTypography.display(
                            size: AppTypography.sizeXl,
                            color: AppColors.haldi)),
                    const SizedBox(height: AppSpacing.s1),
                    Text(
                      'Yeh sirf aapke resume par chhapega. Hum ise kisi aur ko '
                      'nahi dikhate.',
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.onBlueMuted,
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(AppSpacing.gutter),
                  children: <Widget>[
                    Text('POORA NAAM',
                        style: AppTypography.eyebrow(
                            color: AppColors.textMuted)),
                    const SizedBox(height: AppSpacing.s2),
                    TextField(
                      controller: _controller,
                      textCapitalization: TextCapitalization.words,
                      textInputAction: TextInputAction.done,
                      maxLength: 80,
                      autofocus: true,
                      onSubmitted: (_) => _submit(context, state),
                      style: AppTypography.body(size: AppTypography.sizeMd),
                      decoration: InputDecoration(
                        hintText: 'Jaise: Asha Kumari',
                        counterText: '',
                        filled: true,
                        fillColor: AppColors.paper,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.s3,
                          vertical: 14,
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(AppRadii.sm),
                          borderSide:
                              const BorderSide(color: AppColors.borderSubtle),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(AppRadii.sm),
                          borderSide: const BorderSide(
                              color: AppColors.blue, width: 1.5),
                        ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.s6),
                    BbButton(
                      label: state.isSubmitting ? 'Saving…' : 'Continue',
                      block: true,
                      loading: state.isSubmitting,
                      iconRight: Icons.arrow_forward_rounded,
                      onPressed: (_hasText && !state.isSubmitting)
                          ? () => _submit(context, state)
                          : null,
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
