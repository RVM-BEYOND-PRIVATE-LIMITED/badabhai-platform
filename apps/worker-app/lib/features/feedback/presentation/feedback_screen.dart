import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../domain/feedback_category.dart';
import '../domain/feedback_repository.dart';

/// The app-wide feedback page (opened by the floating "Feedback" button on every
/// non-auth screen).
///
/// DELIBERATELY LIGHT — the worker is never boxed in: an optional one-tap
/// category, then a big free-text box they can type anything into. There is no
/// blocking full-screen spinner; only the Send button shows a brief busy state
/// while the post is in flight, and the text stays put so a failed send can be
/// retried without re-typing.
class FeedbackScreen extends StatefulWidget {
  const FeedbackScreen({super.key});

  @override
  State<FeedbackScreen> createState() => _FeedbackScreenState();
}

class _FeedbackScreenState extends State<FeedbackScreen> {
  final TextEditingController _controller = TextEditingController();

  /// Optional coarse tag — null until the worker taps one (and tapping the same
  /// chip again clears it). Never required.
  FeedbackCategory? _category;

  /// True only while a submit is in flight — drives the Send button's busy
  /// state, NOT a modal that blocks the field.
  bool _sending = false;

  bool _hasText = false;

  FeedbackRepository get _repo => locator<FeedbackRepository>();

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

  Future<void> _submit() async {
    final String text = _controller.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await _repo.submit(message: text, category: _category);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(const SnackBar(
          content: Text('Shukriya, aapka feedback mil gaya.'),
        ));
      context.pop();
    } catch (error) {
      if (!mounted) return;
      final Failure failure = mapError(error);
      setState(() => _sending = false);
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(failureReason(failure).reason)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      appBar: const BbAppBar(title: 'Feedback'),
      bottomBar: BbButton(
        label: _sending ? 'Bhej rahe hain…' : 'Bhejein',
        block: true,
        loading: _sending,
        iconRight: Icons.send_rounded,
        onPressed: (_hasText && !_sending) ? _submit : null,
      ),
      body: ListView(
        children: <Widget>[
          const SizedBox(height: AppSpacing.s2),
          Text(
            'Aapko kya accha laga, ya kya theek karna chahiye? Khul kar likhein.',
            style: AppTypography.body(
              size: AppTypography.sizeMd,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
          Text('KIS BAARE MEIN? (OPTIONAL)',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          Wrap(
            spacing: AppSpacing.s2,
            runSpacing: AppSpacing.s2,
            children: <Widget>[
              for (final FeedbackCategory c in FeedbackCategory.values)
                BbChip(
                  label: c.label,
                  selected: _category == c,
                  // Optional + toggleable: tapping the selected chip clears it,
                  // so the worker is never forced into a bucket.
                  onTap: () => setState(
                      () => _category = _category == c ? null : c),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.s5),
          Text('AAPKI BAAT',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s2),
          TextField(
            controller: _controller,
            // Free-form: multi-line, grows as they type, no character cap or
            // format rules — the worker types whatever they want.
            minLines: 5,
            maxLines: null,
            keyboardType: TextInputType.multiline,
            textCapitalization: TextCapitalization.sentences,
            autofocus: true,
            style: AppTypography.body(size: AppTypography.sizeMd),
            decoration: InputDecoration(
              hintText: 'Yahan likhein…',
              filled: true,
              fillColor: AppColors.paper,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.s3,
                vertical: AppSpacing.s3,
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadii.sm),
                borderSide: const BorderSide(color: AppColors.borderSubtle),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadii.sm),
                borderSide: const BorderSide(color: AppColors.blue, width: 1.5),
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.s4),
        ],
      ),
    );
  }
}
