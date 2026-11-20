import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/settings/domain/search_visibility_repository.dart';
import 'package:badabhai_worker_app/features/settings/presentation/cubit/search_visibility_cubit.dart';

/// A scripted [SearchVisibilityRepository]: each call answers or throws what
/// the test sets, so the cubit's 404 / 503 handling is exercised without HTTP.
class _FakeSearchVisibilityRepository implements SearchVisibilityRepository {
  SearchVisibilityDto readResult = const SearchVisibilityDto(visible: true);
  Object? readError;

  SearchVisibilityDto writeResult = const SearchVisibilityDto(visible: true);
  Object? writeError;

  bool? lastWritten;
  int writes = 0;

  @override
  Future<SearchVisibilityDto> read() async {
    if (readError != null) throw readError!;
    return readResult;
  }

  @override
  Future<SearchVisibilityDto> setVisible(bool visible) async {
    writes += 1;
    lastWritten = visible;
    if (writeError != null) throw writeError!;
    return writeResult;
  }
}

void main() {
  late _FakeSearchVisibilityRepository repo;
  late SearchVisibilityCubit cubit;

  setUp(() {
    repo = _FakeSearchVisibilityRepository();
    cubit = SearchVisibilityCubit(repo);
  });

  tearDown(() async => cubit.close());

  test('load renders server truth', () async {
    repo.readResult = const SearchVisibilityDto(visible: false);
    await cubit.load();
    expect(cubit.state.status, SearchVisibilityStatus.ready);
    expect(cubit.state.visible, isFalse);
  });

  test('a 404 means the switch is off — the control is HIDDEN', () async {
    repo.readError = const ServerFailure(404);
    await cubit.load();
    expect(cubit.state.status, SearchVisibilityStatus.unavailable);
  });

  test('a 503 is retryable — the control stays visible as failed', () async {
    repo.readError = const ServerFailure(503);
    await cubit.load();
    expect(cubit.state.status, SearchVisibilityStatus.failed);
    expect(cubit.state.failure, isA<ServerFailure>());
  });

  test('a write sends the RESULTING state and renders the server answer',
      () async {
    repo.writeResult = const SearchVisibilityDto(visible: false);
    final bool held = await cubit.setVisible(false);
    expect(held, isTrue);
    expect(repo.lastWritten, isFalse);
    expect(cubit.state.status, SearchVisibilityStatus.ready);
    expect(cubit.state.visible, isFalse);
  });

  test('a 404 on write hides the control too', () async {
    repo.writeError = const ServerFailure(404);
    await cubit.setVisible(false);
    expect(cubit.state.status, SearchVisibilityStatus.unavailable);
  });

  test('a 503 on write is failed, not hidden, and keeps the old value',
      () async {
    repo.writeError = const ServerFailure(503);
    await cubit.setVisible(false);
    expect(cubit.state.status, SearchVisibilityStatus.failed);
    expect(cubit.state.visible, isTrue);
  });
}
