import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/widgets/onboarding/onboarding_body.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../domain/resume_document_picker.dart';
import '../domain/resume_importer.dart';
import 'cubit/resume_upload_cubit.dart';
import 'widgets/resume_door_tile.dart';

/// The two doors between `/name` and `/chat` (#1499, ADR-0041 RI-6).
///
/// ── WHY A SCREEN AND NOT A QUESTION IN THE CHAT ─────────────────────────────
///
/// A worker who HAS a résumé has already done the work this app is asking him
/// to redo, and asking him about it inside the chat means asking him to type
/// "haan" and then find a paperclip. Two doors put the whole decision on one
/// screen, in his words, with the "no" answer costing exactly one tap.
///
/// There were three. "Hinglish mein baat karein" was removed by owner ruling:
/// it offered a METHOD beside a FACT ("I don't have one"), so a worker with no
/// résumé had to read both tiles to discover they did the same thing. One
/// question per door — `resume_upload_screen_test.dart` pins its absence.
///
/// ── DOOR 2 IS TODAY'S BEHAVIOUR, BYTE FOR BYTE ──────────────────────────────
///
/// This is the requirement that shapes the file. Before #1499, `/name` handed
/// straight to `/chat`; now it hands here, and a worker who does not upload
/// must reach `/chat` having caused the EXACT same request sequence and the
/// EXACT same first chat turn as before.
///
/// So: this screen issues NO request. Not on build, not on entry, not a
/// capability probe, not a "is the upload door open" check. `initState` builds
/// a cubit and nothing else. The 503 that says résumé uploads are switched off
/// is discovered by attempting the mint when — and only when — the worker taps
/// door 1. `resume_upload_screen_test.dart` pins this with a recording client
/// that asserts zero requests for door 2.
///
/// ── AND IT NEVER BECOMES A DEAD END (ruling D9) ─────────────────────────────
///
/// Every outcome of door 1 leaves this screen. A dormant bucket, a parse that
/// found nothing, a dropped upload, a photograph of a blank page — all of them
/// say one honest line and continue in Hinglish. The server's `failure_reason`
/// vocabulary is never shown: see [ResumeUploadNotice].
class ResumeUploadScreen extends StatefulWidget {
  const ResumeUploadScreen({super.key});

  @override
  State<ResumeUploadScreen> createState() => _ResumeUploadScreenState();
}

class _ResumeUploadScreenState extends State<ResumeUploadScreen> {
  late final ResumeUploadCubit _cubit;

  @override
  void initState() {
    super.initState();
    _cubit = ResumeUploadCubit(
      picker: locator<ResumeDocumentPicker>(),
      importer: locator<ResumeImporter>(),
    );
  }

  @override
  void dispose() {
    _cubit.close();
    super.dispose();
  }

  /// The one honest line per notice. Hinglish, `aap`-form, no jargon and no
  /// machine cause — a worker cannot act on `ocr_below_floor`.
  static String _noticeText(ResumeUploadNotice notice) => switch (notice) {
    ResumeUploadNotice.uploadsUnavailable =>
      'Resume upload abhi shuru nahi hua hai. Hum Hinglish mein baat karke '
          'aage badhte hain.',
    ResumeUploadNotice.couldNotRead =>
      'Resume se jaankari nahi mil paayi. Hum Hinglish mein baat karke aage '
          'badhte hain.',
    ResumeUploadNotice.unsupportedType =>
      'Sirf PDF, DOCX, JPG ya PNG file chalegi.',
    ResumeUploadNotice.tooLarge => 'File 10 MB se chhoti honi chahiye.',
  };

  void _onState(BuildContext context, ResumeUploadState state) {
    if (!state.isDone) return;

    // SAID BEFORE WE LEAVE, and on the ROOT messenger so it survives the
    // route change and lands on the screen he is going to — the same pattern
    // `NameScreen` uses for a failed save. Longer than the default: this is an
    // explanation, not a confirmation.
    if (state.notice != null) {
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(
            content: Text(_noticeText(state.notice!)),
            duration: const Duration(seconds: 6),
          ),
        );
    }

    // `go`, NOT `push` — onboarding is a one-way sequence and each completed
    // step REPLACES the last (the #381 rationale `NameScreen` records: a
    // pushed step stays alive underneath and system back walks into it).
    context.go(switch (state.destination!) {
      ResumeUploadDestination.tradeForm => Routes.tradeForm,
      ResumeUploadDestination.chat => Routes.chatProfiling,
    });
  }

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ResumeUploadCubit>.value(
      value: _cubit,
      child: BlocConsumer<ResumeUploadCubit, ResumeUploadState>(
        listenWhen: (ResumeUploadState p, ResumeUploadState c) =>
            p.status != c.status,
        listener: _onState,
        builder: (BuildContext context, ResumeUploadState state) {
          // No back arrow: `/name` is submitted and gone (see `_onState`), so a
          // back affordance here would offer a step that no longer exists.
          //
          // A real [Scaffold] (not a bare Column) so `ScaffoldMessenger` keeps
          // working for the notices. There is no bottom bar: the two doors ARE
          // the actions, so nothing is docked.
          return Scaffold(
            backgroundColor: OnboardingColors.canvasBg,
            body: Column(
              children: <Widget>[
                const ShiftBlueHeader(
                  title: 'Resume hai aapke paas',
                  subtitle:
                      'Resume upload karne se aadhi jaankari apne aap '
                      'bhar jaati hai. Nahi hai to koi baat nahi.',
                ),
                Expanded(
                  child: SafeArea(
                    top: false,
                    child: OnboardingBody(
                      padding: const EdgeInsets.fromLTRB(
                        16,
                        20,
                        16,
                        _kFeedbackFabClearance,
                      ),
                      child: _Doors(state: state),
                    ),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Scroll room under the last door. The app-wide Feedback button floats over
/// this route's bottom-left corner (72 above the safe area, ~48 tall); without
/// this the working note could only ever be read from underneath it on a short
/// phone. Layout only — it adds scroll extent, never a gap on a tall screen's
/// visible content.
const double _kFeedbackFabClearance = 128;

/// Gap between two doors.
const double _kDoorGap = 12;

class _Doors extends StatelessWidget {
  const _Doors({required this.state});

  final ResumeUploadState state;

  @override
  Widget build(BuildContext context) {
    final ResumeUploadCubit cubit = context.read<ResumeUploadCubit>();
    // While anything is in flight BOTH doors are inert — including door 2. A
    // worker who taps "upload" and then "mere paas resume nahi hai" must not
    // end up with a half-registered import behind him in the chat.
    final bool busy = state.isBusy || state.isDone;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // A rejected PICK keeps him here WITH the reason — picking a different
        // file is something he can do from this screen. A terminal notice is
        // never rendered here; it rides the snackbar into the chat.
        if (state.notice != null && !state.isDone)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: _NoticeBanner(
              text: _ResumeUploadScreenState._noticeText(state.notice!),
            ),
          ),

        // DOOR 1 — the only door that touches the network.
        ResumeDoorTile(
          tileKey: const Key('resume_door_upload'),
          icon: Icons.upload_file_outlined,
          title: 'Resume upload karein',
          subtitle: 'PDF, DOCX ya resume ka photo',
          emphasis: true,
          loading:
              state.status == ResumeUploadStatus.picking ||
              state.status == ResumeUploadStatus.working,
          onTap: busy ? null : cubit.chooseDocument,
        ),
        const SizedBox(height: _kDoorGap),

        // DOOR 2 — the only non-upload door, and it is worded as the fact the
        // worker is actually telling us ("I don't have one") rather than as a
        // method he has to pick. The subtitle carries what happens instead,
        // because a refusal with no stated consequence is where he stalls.
        ResumeDoorTile(
          tileKey: const Key('resume_door_no_resume'),
          icon: Icons.do_not_disturb_on_outlined,
          title: 'Mere paas resume nahi hai',
          subtitle: 'Bada Bhai sawaal poochhega aur profile banayega',
          onTap: busy ? null : cubit.continueInChat,
        ),

        if (state.status == ResumeUploadStatus.working)
          const Padding(
            padding: EdgeInsets.only(top: 16),
            child: _WorkingNote(),
          ),
      ],
    );
  }
}

/// The non-terminal explanation, in place, above the doors.
class _NoticeBanner extends StatelessWidget {
  const _NoticeBanner({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: OnboardingColors.noteBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        // Hairline, never a shadow — the kit's note box (as on consent).
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Padding(
            padding: EdgeInsets.only(top: 1),
            child: Icon(
              Icons.info_outline_rounded,
              size: 18,
              color: OnboardingColors.shiftBlue,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: OnboardingTypography.inter(
                size: 13,
                height: 1.4,
                color: OnboardingColors.ink900,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Shown only while bytes are moving or the server is reading. Names what is
/// happening and that it can be slow, so a worker on EDGE does not read a
/// stalled-looking screen as a broken one.
class _WorkingNote extends StatelessWidget {
  const _WorkingNote();

  @override
  Widget build(BuildContext context) {
    return Text(
      'Resume padha ja raha hai. Thoda time lag sakta hai.',
      textAlign: TextAlign.center,
      style: OnboardingTypography.bodyMuted(),
    );
  }
}
