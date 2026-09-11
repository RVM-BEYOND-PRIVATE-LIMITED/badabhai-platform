import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/features/voice/data/voice_pipeline_impl.dart';

/// Maintenance invariant (CLAUDE.md §2): every NEW public ApiClient method MUST
/// have a MockApiClient override, else mock mode falls through to the real
/// network. These calls run against `mock://local`; if an override were missing
/// the call would attempt a real request and fail — so completing here PROVES
/// parity for the A1–A4 additions.
void main() {
  final MockApiClient api = MockApiClient();

  test('getMyApplications returns canned rows using the API action enum', () async {
    final List<AppliedJob> rows =
        await api.getMyApplications(authToken: 'mock');
    // Values match the real ApplicationAction enum ('applied'|'skipped') so the
    // repository's action == 'applied' filter keeps the applied rows.
    expect(rows.where((AppliedJob a) => a.action == 'applied'), isNotEmpty);
    expect(rows.where((AppliedJob a) => a.action == 'skipped'), isNotEmpty);
    expect(rows.every((AppliedJob a) => a.action != 'apply'), isTrue);
  });

  test('uploadVoiceNote (A2) echoes duration without touching the network',
      () async {
    final VoiceUploadResult r = await api.uploadVoiceNote(
      authToken: 'mock',
      sessionId: 's',
      storagePath: 'p',
      durationSeconds: 7,
    );
    expect(r.voiceNoteId, isNotEmpty);
    expect(r.durationSeconds, 7);
  });

  test('transcribeVoiceNote (A2) returns a canned queued job', () async {
    final TranscribeResult r =
        await api.transcribeVoiceNote(authToken: 'mock', voiceNoteId: 'vn');
    expect(r.aiJobId, isNotEmpty);
    expect(r.status, 'queued');
  });

  test(
      'requestVoiceUploadUrl (A2-storage) returns a canned ticket mirroring '
      'the real voice-notes/<workerId>/ path shape', () async {
    final VoiceUploadTicket t =
        await api.requestVoiceUploadUrl(authToken: 'mock');
    expect(t.storagePath, startsWith('voice-notes/'));
    expect(t.storagePath, endsWith('.m4a'));
    expect(t.uploadUrl, isNotEmpty);
    expect(t.expiresInSeconds, greaterThan(0));
  });

  test(
      'fetchVoiceNote (A2-storage) returns the canned transcript, IN SYNC '
      'with MockVoiceTranscriptResolver', () async {
    final VoiceNoteDetail n =
        await api.fetchVoiceNote(authToken: 'mock', voiceNoteId: 'vn');
    expect(n.transcriptText, MockVoiceTranscriptResolver.cannedTranscript);
    expect(n.transcriptEnglish, isNotEmpty);
  });

  test('createInvite (A3) returns a PII-free code + relative link', () async {
    final InviteResult r = await api.createInvite(authToken: 'mock');
    expect(r.code, isNotEmpty);
    expect(r.link, startsWith('/i/'));
  });

  test('requestAccountDelete (A4) returns success + cooldown', () async {
    final AccountDeleteRequestResult r =
        await api.requestAccountDelete(authToken: 'mock');
    expect(r.success, isTrue);
    expect(r.resendInSeconds, greaterThan(0));
  });

  test(
      'confirmAccountDelete (A4/ADR-0031) schedules ~7 days out; '
      'cancelAccountDelete flips it back (both stay off the network)',
      () async {
    final AccountDeleteConfirmResult r =
        await api.confirmAccountDelete(authToken: 'mock', otp: '1234');
    expect(r.success, isTrue);
    // Mirrors the real grace window: due ~now + 7 days.
    expect(r.scheduledFor, isNotNull);
    expect(
      r.scheduledFor!.difference(DateTime.now()).inDays,
      inInclusiveRange(6, 7),
    );

    // Idempotent cancel (a no-op second time), proving the override exists.
    await api.cancelAccountDelete(authToken: 'mock');
    await api.cancelAccountDelete(authToken: 'mock');
  });

  test(
      'the five methods #719 found unoverridden complete without touching the '
      'network — recordWorkerActions is the one VoiceFormActionLog.flush fires '
      'on EVERY flush, so mock mode hit mock://local once per batch', () async {
    // Per the invariant at the top of this file: these run against
    // `mock://local`, so before the overrides existed each call fell through to
    // the real ApiClient and attempted a request. Completing IS the assertion —
    // that is what makes these rows capable of failing.
    await api.recordWorkerActions(
      authToken: 'mock',
      actions: <Map<String, dynamic>>[
        <String, dynamic>{'action': 'voice_form_question_answered'},
      ],
    );
    await api.markNotificationsRead(authToken: 'mock');
    await api.updateNotificationPrefs(enabled: false, authToken: 'mock');

    // The two that also have to return a usable value rather than merely not
    // throw: a null session id is what "this worker has no chat yet" looks
    // like, and prefs default ON to match the server's own default.
    expect(await api.latestChatSessionId(authToken: 'mock'), isNull);
    expect(await api.getNotificationPrefs(authToken: 'mock'), isTrue);
  });

  test(
      'jobDetail (ADR-0024 addendum) returns canned PII-free detail with '
      'NOTHING employer-shaped', () async {
    final JobDetail d =
        await api.jobDetail('mock-job-0001', authToken: 'mock');
    expect(d.jobId, 'mock-job-0001');
    expect(d.payMin, 16000);
    expect(d.payMax, 26000);
    expect(d.shift, 'day');
    expect(d.neededBy, 'immediate');
    expect(d.requirements, isNotEmpty);
    expect(d.benefits, isNotEmpty);

    // The canned copy carries no employer/PII-shaped string on ANY canned id.
    for (final String id in <String>[
      'mock-job-0001',
      'mock-job-0002',
      'mock-job-0003',
      'mock-job-0004',
    ]) {
      final JobDetail detail = await api.jobDetail(id, authToken: 'mock');
      final String dump = detail.props
          .map((Object? p) => p is List ? p.join(' ') : '$p')
          .join(' ');
      expect(dump.contains('Pvt'), isFalse);
      expect(dump.contains('Ltd'), isFalse);
      expect(dump.contains('@'), isFalse);
      expect(RegExp(r'\d{7,}').hasMatch(dump), isFalse);
    }
  });

  test('jobDetail mirrors the real neutral 404 for an unknown job', () {
    expect(
      () => api.jobDetail('mock-job-9999', authToken: 'mock'),
      throwsA(
        isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 404),
      ),
    );
  });

  test(
      'the canned feed pay/shift stay in PARITY with the canned details — '
      'like the real feed and detail routes reading the same jobs row',
      () async {
    final List<FeedItem> feed = await api.getFeed(authToken: 'mock');
    expect(feed, isNotEmpty);
    for (final FeedItem item in feed) {
      final JobDetail detail =
          await api.jobDetail(item.jobId, authToken: 'mock');
      expect(detail.payMin, item.payMin, reason: '${item.jobId} pay_min');
      expect(detail.payMax, item.payMax, reason: '${item.jobId} pay_max');
      expect(detail.shift, item.shift, reason: '${item.jobId} shift');
      expect(detail.title, item.title, reason: '${item.jobId} title');
    }
  });
  // ---- Résumé import (#1499) ----------------------------------------------
  // These three run against `mock://local`. A missing override would attempt a
  // real request and fail here, which is exactly the parity this file exists
  // to prove.

  test('the résumé mint is DORMANT by default, as it is on every real box',
      () async {
    final MockApiClient dormant = MockApiClient();
    // `RESUME_UPLOADS_BUCKET` is unset everywhere today, so mock mode must show
    // the 503 rather than a door that only looks open in dev builds.
    expect(dormant.mockResumeUploadsEnabled, isFalse);
    await expectLater(
      dormant.createResumeUploadUrl(
        mime: 'application/pdf',
        authToken: 'mock',
      ),
      throwsA(isA<ApiException>()
          .having((ApiException e) => e.statusCode, 'statusCode', 503)),
    );
  });

  test('with the bucket enabled it mints, confirms and settles on CHAT',
      () async {
    final MockApiClient live = MockApiClient()
      ..mockResumeUploadsEnabled = true
      ..mockResumeImportPollsBeforeDone = 1;

    final SignedUploadTicket ticket = await live.createResumeUploadUrl(
      mime: 'application/pdf',
      authToken: 'mock',
    );
    expect(ticket.storagePath, startsWith('resume-uploads/'));

    final ResumeImportDto confirmed = await live.confirmResumeImport(
      storagePath: ticket.storagePath,
      authToken: 'mock',
    );
    expect(confirmed.status, ResumeImportStatus.uploaded);
    // NULL until parsing finishes — the real contract, mirrored.
    expect(confirmed.route, isNull);

    final ResumeImportDto parsing =
        await live.getResumeImport(importId: confirmed.importId, authToken: 'mock');
    expect(parsing.status, ResumeImportStatus.parsing);
    expect(parsing.route, isNull);

    final ResumeImportDto done =
        await live.getResumeImport(importId: confirmed.importId, authToken: 'mock');
    expect(done.status, ResumeImportStatus.parsed);
    // `chat` is the DEFAULT because it is the common outcome in production too
    // — only 9 of 21 trades have a form at all.
    expect(done.route, ResumeImportRoute.chat);
  });

  test('the failure branch is reachable and carries no route', () async {
    final MockApiClient failing = MockApiClient()
      ..mockResumeUploadsEnabled = true
      ..mockResumeImportPollsBeforeDone = 0
      ..mockResumeImportFailure = 'no_text_layer';

    final ResumeImportDto confirmed = await failing.confirmResumeImport(
      storagePath: 'resume-uploads/mock-worker-0001/mock-resume-0001.pdf',
      authToken: 'mock',
    );
    final ResumeImportDto done = await failing
        .getResumeImport(importId: confirmed.importId, authToken: 'mock');

    expect(done.status, ResumeImportStatus.failed);
    expect(done.hasFailed, isTrue);
    expect(done.route, isNull);
  });
}
