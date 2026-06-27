import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';

/// Locks the [MockApiClient] MAINTENANCE rule for the new download methods:
/// every new public [ApiClient] network method MUST be overridden in the mock so
/// USE_MOCKS=true never falls through to the real network. These return canned,
/// PII-free `mock.local` urls with no HTTP.
void main() {
  late MockApiClient mock;
  setUp(() => mock = MockApiClient());

  test('downloadResume returns a PII-free mock url (no network)', () async {
    final ResumeDownload dl = await mock.downloadResume(
      resumeId: 'mock-resume-0001',
      authToken: 'mock-token',
    );
    expect(dl.url, 'https://mock.local/resume/mock-resume-0001.pdf');
    expect(dl.expiresInSeconds, 900);
  });

  test('downloadInterviewKit returns a PII-free mock url (no network)', () async {
    final InterviewKitDownload dl =
        await mock.downloadInterviewKit('cnc_operator');
    expect(dl.url, 'https://mock.local/interview-kit/mock-kit-0001.pdf');
    expect(dl.expiresInSeconds, 900);
  });
}
