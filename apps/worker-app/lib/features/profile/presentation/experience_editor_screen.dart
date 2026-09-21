import 'package:flutter/material.dart';

import '../../../core/api/api_client.dart' show WorkPrefOptionsDto;
import '../../../core/error/failure.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/primary_action_button.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../trade_form/domain/trade_form_models.dart';
import '../../trade_form/presentation/cubit/trade_form_cubit.dart'
    show kTradeFormIncompleteEmployerMessage;
import '../../trade_form/presentation/widgets/trade_form_employment_page.dart';

/// #issue5 — the CHAT road's confirm screen ("Yeh sahi hai?") showed one
/// aggregate "Anubhav" number and offered no way to add a SECOND job, while the
/// form road collects up to [kTradeFormMaxEmployers] rows. This screen gives the
/// chat road the same capability by REUSING the form's own repeated-card editor
/// ([TradeFormEmploymentPage]) and persisting through the SAME
/// `PUT /workers/me/employment` the form writes — no new endpoint, no new
/// business rule.
///
/// Deliberately decoupled from the cubit: [initialEntries], [loadOptions] and
/// [onSave] are all injected, so it is testable without a DI graph and usable by
/// any road. It owns the save button (the form wizard's sticky bar normally
/// drives [TradeFormEmploymentPageState.save]); validation and the blank /
/// incomplete rules stay exactly the form's.
class ExperienceEditorScreen extends StatefulWidget {
  const ExperienceEditorScreen({
    super.key,
    required this.initialEntries,
    required this.loadOptions,
    required this.onSave,
  });

  /// The work history already banked for this session — the editor opens with
  /// it, so a second edit REPLACES rather than wipes (the endpoint is a PUT of
  /// the whole list).
  final List<TradeFormEmploymentEntry> initialEntries;

  final Future<WorkPrefOptionsDto> Function() loadOptions;

  /// Persists the WHOLE (non-blank) list. Resolves on success; throws a
  /// [Failure] on error. The screen pops itself with `true` on success.
  final Future<void> Function(List<TradeFormEmploymentEntry> entries) onSave;

  @override
  State<ExperienceEditorScreen> createState() => _ExperienceEditorScreenState();
}

class _ExperienceEditorScreenState extends State<ExperienceEditorScreen> {
  final GlobalKey<TradeFormEmploymentPageState> _pageKey =
      GlobalKey<TradeFormEmploymentPageState>();
  bool _saving = false;

  Future<void> _save() async {
    final TradeFormEmploymentPageState? page = _pageKey.currentState;
    if (page == null || _saving) return;
    // The date rules first (a future/blank/out-of-order date can never reach
    // the wire), then the form's own completeness rule for a used card.
    final String? dateError = page.currentPageError();
    if (dateError != null) {
      _say(dateError);
      return;
    }
    final List<TradeFormEmploymentEntry> entries = page.nonBlankEntries;
    if (entries.any((TradeFormEmploymentEntry e) => !e.isComplete)) {
      _say(kTradeFormIncompleteEmployerMessage);
      return;
    }
    setState(() => _saving = true);
    try {
      await widget.onSave(entries);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on Failure catch (failure) {
      if (!mounted) return;
      setState(() => _saving = false);
      _say(failureReason(failure).reason);
    } catch (_) {
      if (!mounted) return;
      setState(() => _saving = false);
      _say('Save nahi hua — dobara koshish karein.');
    }
  }

  void _say(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        children: <Widget>[
          ShiftBlueHeader(
            title: 'Kaam ka anubhav',
            subtitle: 'Jitni jagah kaam kiya, woh sab jodein.',
            onBack: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: SafeArea(
              top: false,
              child: OnboardingBody(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                child: TradeFormEmploymentPage(
                  key: _pageKey,
                  enabled: !_saving,
                  loadOptions: widget.loadOptions,
                  onSave: (_) {}, // persisted by _save; the page stays a form
                  initialEntries: widget.initialEntries,
                ),
              ),
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: PrimaryActionButton(
            label: 'Save karein',
            showArrow: false,
            isLoading: _saving,
            onPressed: _save,
          ),
        ),
      ),
    );
  }
}
