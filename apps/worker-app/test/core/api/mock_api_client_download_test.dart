import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';

/// Locks the [MockApiClient] MAINTENANCE rule for the download methods: every
/// new public [ApiClient] network method MUST be overridden in the mock so
/// USE_MOCKS=true never falls through to the real network. These return canned,
/// PII-free urls with no HTTP — and their `mock://` SCHEME is load-bearing:
/// `downloadSignedPdf` keys on it to save a placeholder PDF instead of fetching
/// (the sentinel url points nowhere), keeping the flow walkable offline.
void main() {
  late MockApiClient mock;
  setUp(() => mock = MockApiClient());

  test('downloadResume returns a PII-free mock:// url (no network)', () async {
    final ResumeDownload dl = await mock.downloadResume(
      resumeId: 'mock-resume-0001',
      authToken: 'mock-token',
    );
    expect(dl.url, 'mock://downloads/resume/mock-resume-0001.pdf');
    expect(Uri.parse(dl.url).scheme, 'mock');
    expect(dl.expiresInSeconds, 900);
  });

  test('downloadInterviewKit returns a PII-free mock:// url (no network)',
      () async {
    final InterviewKitDownload dl =
        await mock.downloadInterviewKit('cnc_operator');
    expect(dl.url, 'mock://downloads/interview-kit/mock-kit-0001.pdf');
    expect(Uri.parse(dl.url).scheme, 'mock');
    expect(dl.expiresInSeconds, 900);
  });
}
