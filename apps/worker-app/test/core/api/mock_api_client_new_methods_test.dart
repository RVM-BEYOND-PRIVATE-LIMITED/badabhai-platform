import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';

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

  test('confirmAccountDelete (A4) completes (204-equivalent no-op)', () async {
    await api.confirmAccountDelete(authToken: 'mock', otp: '1234');
  });
}
