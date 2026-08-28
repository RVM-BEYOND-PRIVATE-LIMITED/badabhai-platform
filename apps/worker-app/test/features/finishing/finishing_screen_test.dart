import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_repository.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/cubit/finishing_cubit.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/finishing_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements FinishingRepository {}

const WorkPrefOptionsDto _options = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi', 'english': 'English'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
);

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const WorkPreferences());
    registerFallbackValue(<EmploymentEntry>[]);
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(() => repo.loadOptions()).thenAnswer((_) async => _options);
    when(() => repo.saveWorkPreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    locator.registerFactory<FinishingCubit>(() => FinishingCubit(repo));
  });

  tearDown(() => locator.reset());

  Future<GoRouter> pump(WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/finishing',
      routes: <RouteBase>[
        GoRoute(
            path: '/finishing', builder: (_, __) => const FinishingScreen()),
        GoRoute(
            path: '/building',
            builder: (_, __) => const Scaffold(body: Text('BUILDING'))),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    return router;
  }

  testWidgets('renders the language chips from the options endpoint',
      (WidgetTester tester) async {
    await pump(tester);
    expect(find.text('Hindi'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    // and the advance CTA
    expect(find.text('Aage badhein'), findsOneWidget);
  });

  testWidgets('Aage badhein advances to the next page', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tester.tap(find.text('Hindi')); // pick a language
    await tester.pump();
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
    // page 2 = documents, rendered from options.documents_ready
    expect(find.text('Aadhaar'), findsOneWidget);
  });

  testWidgets('a load failure shows a retry', (WidgetTester tester) async {
    when(() => repo.loadOptions()).thenThrow(Exception('boom'));
    await pump(tester);
    expect(find.text('Dobara koshish karein'), findsWidgets);
  });
}
