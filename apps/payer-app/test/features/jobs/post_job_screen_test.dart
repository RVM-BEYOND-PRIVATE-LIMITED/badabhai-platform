import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/features/jobs/presentation/post_job_screen.dart';

/// #357 — the Company post-a-job form shipped FABRICATED prefills
/// ('CNC Setter' / 'Pimpri, Pune') that `_submit()` POSTed verbatim to the real
/// `POST /payer/job-postings`, while the salary / experience / trade / skills
/// inputs it rendered were never read — so a fast tap created a junk-but-real
/// posting and a careful payer's details never reached the server. The
/// '+ Add skill' chip inserted the literal placeholder 'Skill N'.
///
/// These tests fail against the old screen: the prefill assertions find the
/// fabricated text, the untouched-form test sees a real create call, and the
/// wiring test sees `description: null`.

/// Captures every create call so the test can assert what actually rides the
/// wire (the mock base returns a canned draft posting).
class _SpyApi extends MockPayerApiClient {
  final List<({String org, String title, String? location, String? description, String? band})>
      created = <({String org, String title, String? location, String? description, String? band})>[];

  final List<({String title, String city, String? area, int? payMin, int? payMax})>
      createdAgency = <({String title, String city, String? area, int? payMin, int? payMax})>[];

  @override
  Future<JobPosting> createCompanyJob({
    required String orgLabel,
    required String roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
  }) {
    created.add((
      org: orgLabel,
      title: roleTitle,
      location: locationLabel,
      description: description,
      band: vacancyBand,
    ));
    return super.createCompanyJob(
      orgLabel: orgLabel,
      roleTitle: roleTitle,
      locationLabel: locationLabel,
      description: description,
      vacancyBand: vacancyBand,
      vacancies: vacancies,
    );
  }

  @override
  Future<AgencyJobView> createAgencyJob({
    required String tradeKey,
    required String title,
    required String city,
    String? area,
    int? payMin,
    int? payMax,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
  }) {
    createdAgency.add((
      title: title,
      city: city,
      area: area,
      payMin: payMin,
      payMax: payMax,
    ));
    return super.createAgencyJob(
      tradeKey: tradeKey,
      title: title,
      city: city,
      area: area,
      payMin: payMin,
      payMax: payMax,
      minExperienceYears: minExperienceYears,
      maxExperienceYears: maxExperienceYears,
      neededBy: neededBy,
    );
  }
}

void main() {
  late _SpyApi api;

  Future<void> pump(WidgetTester tester, PayerRole role) async {
    await GetIt.instance.reset();
    api = _SpyApi();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    locator<AppSessionCubit>().signIn(role);

    // The form is taller than the default 600px test viewport. A tall viewport
    // builds EVERY field, which both lets us reach 'Post job' without scrolling
    // and keeps the `findsNothing` prefill assertions honest — off-screen text
    // would satisfy them for the wrong reason.
    tester.view.physicalSize = const Size(1000, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: PostJobScreen(onBack: () {}))),
    );
    await tester.pumpAndSettle();
  }

  /// Type into the field that currently shows [label] (BbField renders the label
  /// as a sibling Text above its TextField).
  Future<void> typeInto(
    WidgetTester tester,
    String label,
    String value,
  ) async {
    final Finder field = find.ancestor(
      of: find.text(label),
      matching: find.byType(Column),
    );
    await tester.enterText(
      find.descendant(of: field.first, matching: find.byType(TextField)),
      value,
    );
    await tester.pump();
  }

  /// Never `pumpAndSettle` here: on a SUCCESSFUL post the screen leaves
  /// `_submitting` true (it hands off to `onBack`), so the button keeps its
  /// spinner and the tree never goes idle. Fixed pumps let the toast appear.
  Future<void> tapPost(WidgetTester tester) async {
    await tester.tap(find.text('Post job'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
  }

  group('#357 — no fabricated prefills', () {
    testWidgets('company form starts with empty title and location',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company);

      // The exact fabricated values the old screen shipped.
      expect(find.text('CNC Setter'), findsNothing);
      expect(find.text('Pimpri, Pune'), findsNothing);
      expect(find.text('₹22k–28k'), findsNothing);
      expect(find.text('3+ yrs'), findsNothing);
      // ...and the seeded skill chips.
      expect(find.text('Fanuc'), findsNothing);
      expect(find.text('VMC setting'), findsNothing);

      // Org name IS legitimately prefilled — it is the signed-in account.
      expect(find.text('Kalyani Industries'), findsOneWidget);
    });

    testWidgets('agency form starts with empty city and area',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.agency);

      expect(find.text('Pune'), findsNothing);
      expect(find.text('Chakan'), findsNothing);
    });

    testWidgets('untouched company form posts nothing', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await tapPost(tester);

      // The old screen posted 'CNC Setter' @ 'Pimpri, Pune' right here.
      expect(api.created, isEmpty);
      expect(find.text('Add the basics'), findsOneWidget);
    });

    testWidgets('untouched agency form posts nothing', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);
      await tapPost(tester);

      expect(api.createdAgency, isEmpty);
    });
  });

  group('#357 — collected inputs reach the create call', () {
    testWidgets('trade, pay, experience and skills ride `description`', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Job title', 'VMC Operator');
      await typeInto(tester, 'Location', 'Nashik');
      await typeInto(tester, 'Pay min ₹/mo', '22000');
      await typeInto(tester, 'Pay max ₹/mo', '28000');
      await typeInto(tester, 'Exp min (yrs)', '2');
      await typeInto(tester, 'Exp max (yrs)', '6');

      // Trade is a deliberate pick — it starts unset so nothing lands in the
      // description the payer did not choose.
      await tester.tap(find.text('Not specified'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Quality Inspector').last);
      await tester.pumpAndSettle();

      await tester.tap(find.text('+ Add skill'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('add-skill-field')), 'Fanuc');
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();

      await tapPost(tester);

      expect(api.created, hasLength(1));
      final created = api.created.single;
      expect(created.title, 'VMC Operator');
      expect(created.location, 'Nashik');
      expect(created.org, 'Kalyani Industries');

      // The whole point of the issue: none of this used to be sent.
      final String description = created.description!;
      expect(description, contains('Trade: Quality Inspector'));
      expect(description, contains('Monthly pay: ₹22,000–₹28,000'));
      expect(description, contains('Experience: 2–6 yrs'));
      expect(description, contains('Key skills: Fanuc'));
    });

    testWidgets('an untouched detail block sends NO description, not filler', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await typeInto(tester, 'Job title', 'Fitter');
      await tapPost(tester);

      expect(api.created.single.description, isNull);
    });

    testWidgets('pay band is rejected when max is below min', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'Pay min ₹/mo', '30000');
      await typeInto(tester, 'Pay max ₹/mo', '20000');
      await tapPost(tester);

      expect(api.created, isEmpty);
      expect(find.text('Max pay must be at least the min.'), findsOneWidget);
    });
  });

  group('#357 — Add skill prompts instead of inserting a placeholder', () {
    testWidgets('adds the typed phrase, never "Skill 1"', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);

      await tester.tap(find.text('+ Add skill'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('add-skill-field')),
        'Fanuc Oi-MF',
      );
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();

      expect(find.text('Fanuc Oi-MF'), findsOneWidget);
      expect(find.text('Skill 1'), findsNothing);
    });

    testWidgets('a phone-shaped skill is refused at entry (no PII on the wire)',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company);

      await tester.tap(find.text('+ Add skill'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('add-skill-field')),
        'call 98765 43210',
      );
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();

      expect(find.text('call 98765 43210'), findsNothing);
      expect(find.text('Not a skill'), findsOneWidget);
    });
  });
}
