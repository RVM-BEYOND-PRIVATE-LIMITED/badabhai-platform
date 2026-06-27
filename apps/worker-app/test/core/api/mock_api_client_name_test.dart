import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';

/// Locks the MockApiClient MAINTENANCE rule for updateName: the new public
/// ApiClient method MUST be overridden so USE_MOCKS=true never falls through to
/// the network. The mock is a no-op that neither stores nor echoes the name.
void main() {
  test('updateName completes with no network and returns nothing observable', () async {
    final MockApiClient mock = MockApiClient();
    await expectLater(
      mock.updateName(fullName: 'Asha Kumari', authToken: 'mock-token'),
      completes,
    );
  });
}
