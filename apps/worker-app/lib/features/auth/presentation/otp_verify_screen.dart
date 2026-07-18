import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_client.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/otp/sms_otp_autofill.dart';
import '../../../core/session/session_repository.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/date_label.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../router.dart';
import '../domain/auth_session_manager.dart';
import 'cubit/otp_verify_cubit.dart';

/// How many cells the code is entered into. The API mints `OTP_LENGTH` digits
/// (default 6); if that ever changes server-side this must follow, or the
/// worker gets a row of boxes that cannot hold their code.
const int kOtpLength = 6;

/// TalkBack's name for the code entry. Exported so the widget test asserts the
/// SAME string the worker hears (see [kBackspaceSemanticLabel] on the keypad).
const String kOtpFieldSemanticLabel = 'SMS code, $kOtpLength digits';

/// Typed `extra` for [Routes.otpVerify] (#336).
///
/// Exists so the OTP screen can be handed the server's `resend_in_seconds`
/// alongside the phone. Before this the route's `extra` was a bare `String`
/// (the phone), the screen's `resendIn` was therefore always null, and the
/// resend button armed itself the moment the screen opened — while the server
/// was still inside its own cooldown and would answer OTP_RATE_LIMITED.
class OtpVerifyArgs {
  const OtpVerifyArgs({required this.phone, this.resendIn});

  final String? phone;

  /// The cooldown reported by the send that got the worker here. Null means
  /// "not told" — the resend starts enabled and the server stays the only gate.
  final Duration? resendIn;
}

class OtpVerifyScreen extends StatelessWidget {
  const OtpVerifyScreen({super.key, this.phone, this.resendIn});

  /// The phone the OTP was sent to (passed as go_router `extra` from login).
  final String? phone;

  /// #336 — the server's `resend_in_seconds` from the send that got the worker
  /// here, so the countdown is already running when the screen opens.
  ///
  /// Null means "not told" — the router builds this screen from `extra` typed
  /// `String?` (the phone), so today nothing hands the value across even though
  /// `OtpRequestResult.resendIn` parses it. The resend then starts ENABLED and
  /// the server's own cooldown is the only gate: an early tap costs a round
  /// trip and an OTP_RATE_LIMITED line, never an SMS. Wiring login → here is a
  /// one-line router change tracked on #336.
  final Duration? resendIn;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<OtpVerifyCubit>(
      create: (_) => locator<OtpVerifyCubit>(),
      child: _OtpVerifyView(phone: phone ?? '', resendIn: resendIn),
    );
  }
}

class _OtpVerifyView extends StatefulWidget {
  const _OtpVerifyView({required this.phone, this.resendIn});

  final String phone;
  final Duration? resendIn;

  @override
  State<_OtpVerifyView> createState() => _OtpVerifyViewState();
}

class _OtpVerifyViewState extends State<_OtpVerifyView> {
  final TextEditingController _controller = TextEditingController();

  /// Drives the active-cell ring. The cells are painted, not focusable, so the
  /// ONE real field's focus is the only source of "where am I typing".
  final FocusNode _focusNode = FocusNode();

  /// Android SMS auto-read. Null when the locator has no instance (widget tests
  /// that wire their own graph) — the screen stays fully usable by typing.
  SmsOtpAutofill? _autofill;
  StreamSubscription<String>? _codeSub;

  /// #336 — seconds left before another OTP may be requested. While > 0 the
  /// resend control is disabled and shows the remaining seconds; at 0 it
  /// re-arms. Seeded from the server value and restarted from the fresh server
  /// value on every successful resend — never from a client constant.
  int _cooldown = 0;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _cooldown = widget.resendIn?.inSeconds ?? 0;
    _startCooldown();
    if (!locator.isRegistered<SmsOtpAutofill>()) return;
    final SmsOtpAutofill autofill = locator<SmsOtpAutofill>();
    _autofill = autofill;
    // The SMS can beat this route: PhoneLoginCubit opened the window before the
    // request, so a code may already be waiting. Drain it, THEN listen for one
    // that lands while this screen is up.
    final String? buffered = autofill.takeBufferedCode();
    if (buffered != null) _onCode(buffered);
    _codeSub = autofill.codes.listen(_onCode);
  }

  /// Fill the field with the detected code. Deliberately does NOT auto-submit:
  /// the backend counts verify attempts against the phone, so a misread would
  /// silently burn one. The worker sees the code land and taps Verify.
  void _onCode(String code) {
    if (!mounted) return;
    _controller.text = code;
    _controller.selection =
        TextSelection.collapsed(offset: _controller.text.length);
  }

  /// #336 — start (or restart) the countdown over whatever [_cooldown] the
  /// caller just set from the SERVER value. The caller owns the assignment (the
  /// _DeleteOtpDialog countdown in settings_screen does the same) so that
  /// initState can seed it without an illegal pre-first-frame setState, while
  /// the resend listener wraps its own assignment in one.
  void _startCooldown() {
    _ticker?.cancel();
    if (_cooldown <= 0) return;
    _ticker = Timer.periodic(const Duration(seconds: 1), (Timer t) {
      // Belt AND braces with dispose()'s cancel: a tick that lands after unmount
      // would call setState on a defunct State and throw — from a background
      // timer, so it surfaces as a bare red screen with no action behind it.
      if (!mounted) {
        t.cancel();
        return;
      }
      setState(() => _cooldown = _cooldown > 0 ? _cooldown - 1 : 0);
      if (_cooldown <= 0) t.cancel();
    });
  }

  @override
  void dispose() {
    // #336 — cancelled FIRST and unconditionally. A periodic ticker outlives the
    // widget: the worker verifies and routes to consent, the timer keeps firing
    // into a disposed State, and setState throws once a second for the rest of
    // the cooldown. It also keeps the whole State (and its controller) alive.
    _ticker?.cancel();
    _codeSub?.cancel();
    // Close the consent window — the OTP is entered, so nothing should keep
    // listening for another 5 minutes.
    _autofill?.stopListening();
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  /// Post-verify success. If a deletion is pending (ADR-0031 grace window) the
  /// EXPLICIT cancel prompt comes FIRST — ruling (a): login must never
  /// auto-cancel a formally-confirmed deletion — then routing proceeds either
  /// way (a declined/failed cancel can still be done later from Settings).
  Future<void> _onVerified(BuildContext context, OtpVerifyState state) async {
    final DateTime? pendingDeletion = state.deletionScheduledFor;
    if (pendingDeletion != null) {
      await _promptPendingDeletion(context, pendingDeletion);
      if (!context.mounted) return;
    }
    _routeNext(context, state.next!);
  }

  /// Route off the resolved next-step (exhaustive — all three arms):
  void _routeNext(BuildContext context, OtpNext next) {
    switch (next) {
      case OtpNext.onboarding:
        // Persistent-auth OFF (real/default build until the backend
        // /auth/* contract lands): replicate main's OTP→consent flow —
        // PUSH the consent gate, then the worker walks consent → name →
        // chat → profile → resume. No PIN; the auth redirect is inert.
        context.push(Routes.consent);
      case OtpNext.setPin:
        // New user (gate ON) → choose a PIN before the shell.
        context.go(Routes.setPin);
      case OtpNext.authenticated:
        // Returning worker with a PIN (gate ON) → straight to the shell
        // (no re-profiling) — unless the server said this worker has NO
        // active consent (TD62): then the consent gate comes first. Only a
        // definitive false routes there (null = old server, pass). The
        // redirect blocks onboarding routes anyway.
        final bool needsConsent =
            locator<AuthSessionManager>().consentAccepted == false;
        context.go(needsConsent ? Routes.consent : Routes.resume);
    }
  }

  /// The pending-deletion prompt: a non-backdrop-dismissible choice between
  /// cancelling the deletion and letting it proceed. Backdrop dismissal is off
  /// because this is a formal choice — but "Nahin, delete hone dein" routes on
  /// without touching the schedule.
  Future<void> _promptPendingDeletion(
    BuildContext context,
    DateTime scheduledFor,
  ) async {
    final bool cancelRequested = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (BuildContext dialogContext) => AlertDialog(
            title: const Text('Account delete hone wala hai'),
            content: Text(
              'Aapka account ${absoluteDateLabel(scheduledFor)} ko delete ho '
              'jaayega. Kya aap delete cancel karna chahte hain?',
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                style: TextButton.styleFrom(foregroundColor: AppColors.danger),
                child: const Text('Nahin, delete hone dein'),
              ),
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: const Text('Delete cancel karein'),
              ),
            ],
          ),
        ) ??
        false;
    if (!cancelRequested || !context.mounted) return;
    await _cancelPendingDeletion(context);
  }

  /// Calls the cancel route with the FRESH session token the verify just
  /// bridged. On success the SessionRepository flag clears; on failure the
  /// honest reason shows and routing continues — the worker can still cancel
  /// from the Settings banner (the pending flag stays set).
  Future<void> _cancelPendingDeletion(BuildContext context) async {
    // Capture the messenger before the async gap (use_build_context_synchronously).
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final SessionRepository session = locator<SessionRepository>();
    try {
      final String? token = session.sessionToken;
      if (token == null || token.isEmpty) {
        throw const UnauthorizedFailure();
      }
      await locator<ApiClient>().cancelAccountDelete(authToken: token);
      session.setDeletionScheduledFor(null);
      messenger
        ..clearSnackBars()
        ..showSnackBar(
            const SnackBar(content: Text('Account delete cancel ho gaya')));
    } catch (error) {
      messenger
        ..clearSnackBars()
        ..showSnackBar(SnackBar(
          backgroundColor: AppColors.danger,
          content: Text(failureReason(mapError(error)).reason),
        ));
    }
  }

  /// #336 — reacts to a resend landing. Kept in its OWN listener, with its own
  /// `listenWhen`, rather than folded into the verify listener below: that one
  /// fires on any `status` change, so it would restart the countdown every time
  /// a verify failed — handing the worker a fresh 30s wait for a typo.
  void _onResendChanged(BuildContext context, OtpVerifyState state) {
    switch (state.resendStatus) {
      case OtpResendStatus.sent:
        // Restart from the FRESH server cooldown, so the control re-arms only
        // when the server would actually accept another send. setState here
        // rather than leaning on the rebuild the same state change triggers:
        // listener/builder ordering is not ours to assume, and a missed frame
        // would leave the control tappable for a second with the cooldown live.
        setState(() => _cooldown = state.resendInSeconds);
        _startCooldown();
      case OtpResendStatus.failure:
        ScaffoldMessenger.of(context)
          ..clearSnackBars()
          ..showSnackBar(SnackBar(
            backgroundColor: AppColors.danger,
            // The honest reason (rate-limited vs offline) — the worker can only
            // act on it if we say which one it was.
            content: Text(state.resendMessage ?? 'Code bhej nahi paaye.'),
          ));
      case OtpResendStatus.idle:
      case OtpResendStatus.sending:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final String phone = widget.phone;
    return BlocListener<OtpVerifyCubit, OtpVerifyState>(
      listenWhen: (OtpVerifyState prev, OtpVerifyState curr) =>
          prev.resendStatus != curr.resendStatus,
      listener: _onResendChanged,
      child: _buildBody(context, phone),
    );
  }

  Widget _buildBody(BuildContext context, String phone) {
    return BlocConsumer<OtpVerifyCubit, OtpVerifyState>(
      listenWhen: (prev, curr) => prev.status != curr.status,
      listener: (BuildContext context, OtpVerifyState state) {
        if (state.status == OtpVerifyStatus.success) {
          // Fire-and-forget: the pending-deletion prompt (if any) is awaited
          // inside, then routing runs. The listener itself stays sync.
          unawaited(_onVerified(context, state));
        } else if (state.status == OtpVerifyStatus.failure) {
          // Surface the verify failure instead of silently reverting the button.
          ScaffoldMessenger.of(context)
            ..clearSnackBars()
            ..showSnackBar(
              SnackBar(
                backgroundColor: AppColors.danger,
                content: Text(
                  state.message ?? 'Could not verify the code. Please try again.',
                ),
              ),
            );
        }
      },
      builder: (BuildContext context, OtpVerifyState state) {
        return BbScaffold(
          appBar: const BbAppBar(title: 'Verify OTP'),
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const SizedBox(height: AppSpacing.s7),
              Text('Enter the code',
                  style: AppTypography.display(size: AppTypography.sizeXl)),
              const SizedBox(height: AppSpacing.s2),
              Text(
                'Sent to $phone',
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
              const SizedBox(height: AppSpacing.s6),
              _buildCodeField(),
              const SizedBox(height: AppSpacing.s7),
              BbButton(
                label: state.isSubmitting ? 'Verifying…' : 'Verify',
                block: true,
                loading: state.isSubmitting,
                onPressed: state.isSubmitting
                    ? null
                    : () => context.read<OtpVerifyCubit>().verify(
                          phone: phone,
                          otp: _controller.text.trim(),
                        ),
              ),
              const SizedBox(height: AppSpacing.s3),
              _buildResend(context, state, phone),
            ],
          ),
        );
      },
    );
  }

  /// #336 — the segmented code entry: [kOtpLength] painted cells with ONE real
  /// [TextField] laid invisibly over them.
  ///
  /// Six real fields is the obvious build and the wrong one — it breaks every
  /// path that actually gets a code into this screen. SMS auto-read and iOS
  /// `oneTimeCode` autofill deliver the whole code to a single field; a worker
  /// pasting the code copied out of their SMS app has one place to drop it,
  /// not six; and TalkBack would announce six disconnected "edit box"es to
  /// exactly the worker who cannot read the screen to work out what they mean.
  ///
  /// So the cells are pure decoration — [ExcludeSemantics] and never hit-tested
  /// — and the field on top keeps the real keyboard, selection/paste menu,
  /// autofill and a single semantics node. Its text is drawn transparent (not
  /// zero-sized: a collapsed field cannot be tapped or long-pressed) and the
  /// cells below render the digits.
  Widget _buildCodeField() {
    return SizedBox(
      height: AppSpacing.controlLg,
      child: Stack(
        children: <Widget>[
          Positioned.fill(
            child: ExcludeSemantics(
              child: ListenableBuilder(
                listenable: Listenable.merge(<Listenable>[
                  _controller,
                  _focusNode,
                ]),
                builder: (BuildContext context, _) => _OtpCells(
                  code: _controller.text,
                  focused: _focusNode.hasFocus,
                ),
              ),
            ),
          ),
          Positioned.fill(
            // MergeSemantics collapses the label into the field's own node, so
            // TalkBack reads one "SMS code, 6 digits, edit box" instead of a
            // stray label followed by an unnamed box (the bb_job_card pattern).
            child: MergeSemantics(
              child: Semantics(
                label: kOtpFieldSemanticLabel,
                child: TextField(
                  key: const Key('otpCodeField'),
                  controller: _controller,
                  focusNode: _focusNode,
                  // Single-purpose screen: the worker arrives here to type one
                  // thing, so the keyboard is up without a hunt for the field.
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  textAlign: TextAlign.center,
                  textAlignVertical: TextAlignVertical.center,
                  // Digits only, capped at the length the API mints — so a
                  // pasted "Your OTP is 123456" cannot land as-is, and a stray
                  // 7th digit cannot silently push the code out of range.
                  inputFormatters: <TextInputFormatter>[
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(kOtpLength),
                  ],
                  // iOS: this is the whole auto-fill story — the OS surfaces the
                  // SMS code above the keyboard natively. Android ignores it
                  // unless an autofill service handles SMS OTP, which is why the
                  // real Android path is SmsOtpAutofill (Play Services User
                  // Consent) wired in initState.
                  autofillHints: const <String>[AutofillHints.oneTimeCode],
                  // Long-press → Paste stays alive; it is how a worker who
                  // switched to the SMS app gets the code back here.
                  enableInteractiveSelection: true,
                  // The caret would sit at the centre of the row, nowhere near
                  // the cell being filled. The active cell's ring is the caret.
                  showCursor: false,
                  cursorColor: Colors.transparent,
                  style: AppTypography.mono(
                    size: AppTypography.sizeXl,
                    weight: FontWeight.w700,
                    color: Colors.transparent,
                  ),
                  decoration: const InputDecoration(
                    counterText: '',
                    filled: false,
                    border: InputBorder.none,
                    enabledBorder: InputBorder.none,
                    focusedBorder: InputBorder.none,
                    contentPadding: EdgeInsets.zero,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// #336 — the resend control. Disabled for the whole server cooldown, and it
  /// SAYS how long is left: a dead button with no explanation reads as a broken
  /// app to a first-time worker, who then reinstalls or gives up.
  Widget _buildResend(
      BuildContext context, OtpVerifyState state, String phone) {
    final bool canResend = _cooldown == 0 && !state.isResending;
    final String label;
    if (_cooldown > 0) {
      label = 'Naya code ${_cooldown}s mein';
    } else if (state.isResending) {
      label = 'Bhej rahe hain…';
    } else {
      label = 'Naya code bhejein';
    }
    return SizedBox(
      // Full tap height even while disabled, so the row does not resize when it
      // re-arms and shove the Verify button under the worker's thumb mid-tap.
      height: AppSpacing.tap,
      child: TextButton.icon(
        key: const Key('otpResendButton'),
        onPressed: canResend
            ? () => unawaited(
                  context.read<OtpVerifyCubit>().resend(phone: phone),
                )
            : null,
        icon: const Icon(Icons.refresh_rounded, size: 20),
        label: Text(
          label,
          style: AppTypography.body(
            weight: FontWeight.w700,
            color: canResend ? AppColors.textLink : AppColors.textMuted,
          ),
        ),
      ),
    );
  }
}

/// The painted OTP cells. Decoration only — it is handed the code the real
/// field already holds and never owns or mutates it.
class _OtpCells extends StatelessWidget {
  const _OtpCells({required this.code, required this.focused});

  /// The digits typed so far. NOT persisted, NOT logged, NOT put in cubit
  /// state (CLAUDE.md §2): a one-time code in an error dump is a credential.
  final String code;

  /// Whether the real field has focus — only then does a cell show the ring.
  final bool focused;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        for (int i = 0; i < kOtpLength; i++) ...<Widget>[
          if (i > 0) const SizedBox(width: AppSpacing.s2),
          Expanded(child: _cell(i)),
        ],
      ],
    );
  }

  Widget _cell(int index) {
    final bool filled = index < code.length;
    // The next empty cell is the one being typed into; once the code is full
    // the ring stays on the last cell rather than vanishing off the end.
    final bool active = focused &&
        index == (code.length >= kOtpLength ? kOtpLength - 1 : code.length);
    final Color border = active
        ? AppColors.brand
        : (filled ? AppColors.borderStrong : AppColors.borderDefault);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: filled ? AppColors.surfaceCard : AppColors.surfaceInset,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: border, width: active ? 2 : 1.5),
      ),
      child: Center(
        child: Text(
          filled ? code[index] : '',
          style: AppTypography.mono(
            size: AppTypography.sizeXl,
            weight: FontWeight.w700,
            letterSpacing: 0,
          ),
        ),
      ),
    );
  }
}
