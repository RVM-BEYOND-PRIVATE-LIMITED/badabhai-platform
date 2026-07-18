import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
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
        return BbScaffold(
          appBar: const BbAppBar(title: 'Your name'),
          bottomBar: BbButton(
            label: state.isSubmitting ? 'Saving…' : 'Continue',
            block: true,
            loading: state.isSubmitting,
            iconRight: Icons.arrow_forward_rounded,
            onPressed:
                (_hasText && !state.isSubmitting) ? () => _submit(context, state) : null,
          ),
          body: ListView(
            padding: const EdgeInsets.only(top: AppSpacing.s6),
            children: <Widget>[
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: AppColors.saffron100,
                  borderRadius: BorderRadius.circular(AppRadii.md),
                ),
                child: const Icon(Icons.badge_outlined,
                    color: AppColors.saffron700, size: 30),
              ),
              const SizedBox(height: AppSpacing.s4),
              Text('Aapka naam?',
                  style: AppTypography.display(size: AppTypography.sizeXl)),
              const SizedBox(height: AppSpacing.s3),
              Text(
                'Yeh sirf aapke resume par chhapega. Hum ise kisi aur ko nahi '
                'dikhate.',
                style: AppTypography.body(
                  size: AppTypography.sizeMd,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: AppSpacing.s5),
              TextField(
                controller: _controller,
                textCapitalization: TextCapitalization.words,
                textInputAction: TextInputAction.done,
                maxLength: 80,
                autofocus: true,
                onSubmitted: (_) => _submit(context, state),
                decoration: const InputDecoration(
                  labelText: 'Poora naam',
                  hintText: 'Jaise: Asha Kumari',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
