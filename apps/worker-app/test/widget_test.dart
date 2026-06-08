import 'package:flutter_test/flutter_test.dart';
import 'package:badabhai_worker_app/app.dart';

void main() {
  testWidgets('Splash shows brand and get-started CTA', (WidgetTester tester) async {
    await tester.pumpWidget(const BadaBhaiApp());
    expect(find.text('BadaBhai'), findsOneWidget);
    expect(find.text('Get started'), findsOneWidget);
  });
}
