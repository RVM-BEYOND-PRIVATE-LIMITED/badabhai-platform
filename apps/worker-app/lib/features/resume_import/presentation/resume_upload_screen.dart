import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_blue_header.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_scroll_safe_body.dart';
import '../../../router.dart';
import '../domain/resume_document_picker.dart';
import '../domain/resume_importer.dart';
import 'cubit/resume_upload_cubit.dart';
import 'widgets/resume_door_tile.dart';

/// The three doors between `/name` and `/chat` (#1499, ADR-0041 RI-6).
///
/// ── WHY A SCREEN AND NOT A QUESTION IN THE CHAT ─────────────────────────────
///
/// A worker who HAS a résumé has already done the work this app is asking him
/// to redo, and asking him about it inside the chat means asking him to type
/// "haan" and then find a paperclip. The three doors put the whole decision on
/// one screen, in his words, with the two "no" answers costing exactly one tap.
///
/// ── DOORS 2 AND 3 ARE TODAY'S BEHAVIOUR, BYTE FOR BYTE ──────────────────────
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
/// that asserts zero requests for doors 2 and 3.
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
          return BbScaffold(
            padded: false,
            safeArea: false,
            body: Column(
              children: <Widget>[
                const BbBlueHeader(
                  title: 'Resume hai aapke paas',
                  subtitle: 'Resume upload karne se aadhi jaankari apne aap '
                      'bhar jaati hai. Nahi hai to koi baat nahi.',
                ),
                Expanded(
                  child: BbScrollSafeBody(
                    padding: const EdgeInsets.all(AppSpacing.gutter),
                    child: _Doors(state: state),
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

class _Doors extends StatelessWidget {
  const _Doors({required this.state});

  final ResumeUploadState state;

  @override
  Widget build(BuildContext context) {
    final ResumeUploadCubit cubit = context.read<ResumeUploadCubit>();
    // While anything is in flight EVERY door is inert — including doors 2 and
    // 3. A worker who taps "upload" and then "baat karein" must not end up
    // with a half-registered import behind him in the chat.
    final bool busy = state.isBusy || state.isDone;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // A rejected PICK keeps him here WITH the reason — picking a different
        // file is something he can do from this screen. A terminal notice is
        // never rendered here; it rides the snackbar into the chat.
        if (state.notice != null && !state.isDone)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.s5),
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
          loading: state.status == ResumeUploadStatus.picking ||
              state.status == ResumeUploadStatus.working,
          onTap: busy ? null : cubit.chooseDocument,
        ),
        const SizedBox(height: AppSpacing.s4),

        // DOOR 2 — today's path, unchanged.
        ResumeDoorTile(
          tileKey: const Key('resume_door_chat'),
          icon: Icons.chat_bubble_outline,
          title: 'Hinglish mein baat karein',
          subtitle: 'Bada Bhai sawaal poochhega, aap jawaab dijiye',
          onTap: busy ? null : cubit.continueInChat,
        ),
        const SizedBox(height: AppSpacing.s4),

        // DOOR 3 — a DIFFERENT question, the SAME behaviour. Separate because a
        // worker who has no résumé is not choosing a method, he is telling us a
        // fact, and a screen that makes him read door 2 as the answer to that
        // is a screen he stalls on.
        ResumeDoorTile(
          tileKey: const Key('resume_door_no_resume'),
          icon: Icons.do_not_disturb_on_outlined,
          title: 'Mere paas resume nahi hai',
          subtitle: 'Koi dikkat nahi, baat karke bana denge',
          onTap: busy ? null : cubit.continueInChat,
        ),

        if (state.status == ResumeUploadStatus.working)
          const Padding(
            padding: EdgeInsets.only(top: AppSpacing.s5),
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
      padding: const EdgeInsets.all(AppSpacing.s4),
      decoration: BoxDecoration(
        color: AppColors.haldiTint,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        // Hairline, never a shadow (JUL31 §separation).
        border: Border.all(color: AppColors.borderDouble),
      ),
      child: Text(
        text,
        style: AppTypography.body(color: AppColors.ink800),
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
      style: AppTypography.body(size: 14, color: AppColors.ink550),
    );
  }
}
