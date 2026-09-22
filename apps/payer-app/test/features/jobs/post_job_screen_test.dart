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

  /// The worker-visible content of the last agency create — the four fields the
  /// job card renders verbatim and the form used to have no input for.
  String? agencyDescription;
  String? agencyShift;
  List<String>? agencyBenefits;
  List<String>? agencyRequirements;

  /// Every company PATCH the screen fires AFTER a create (the repair of what the
  /// create schema silently strips).
  final List<
      ({
        String id,
        String? city,
        int? payMin,
        int? payMax,
        String? shift,
        String? neededBy,
        List<String>? matchSkillIds,
      })> patched = <({
    String id,
    String? city,
    int? payMin,
    int? payMax,
    String? shift,
    String? neededBy,
    List<String>? matchSkillIds,
  })>[];

  /// The worker-visible display half of the last COMPANY create. The `created`
  /// record above keeps the four identity/vacancy fields; these are what the
  /// create route used to strip and now persists (#1653).
  String? companyCity;
  int? companyPayMin;
  int? companyPayMax;
  String? companyShift;
  String? companyNeededBy;

  /// When set, every [updateJob] throws it — the partial-save path.
  Object? throwOnUpdate;

  // These #357 tests assert the LEGACY free-text skills flow, so present
  // Matching V1 as unavailable (route off) — the screen degrades to the
  // free-text path. The picker itself is exercised against a real backend.
  @override
  Future<List<MatchSkill>> fetchMatchSkills() async => const <MatchSkill>[];

  @override
  Future<JobPosting> createCompanyJob({
    required String orgLabel,
    required String roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? shift,
    String? neededBy,
    List<String>? benefits,
    List<String>? requirements,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
  }) {
    created.add((
      org: orgLabel,
      title: roleTitle,
      location: locationLabel,
      description: description,
      band: vacancyBand,
    ));
    companyCity = city;
    companyPayMin = payMin;
    companyPayMax = payMax;
    companyShift = shift;
    companyNeededBy = neededBy;
    return super.createCompanyJob(
      orgLabel: orgLabel,
      roleTitle: roleTitle,
      locationLabel: locationLabel,
      description: description,
      vacancyBand: vacancyBand,
      vacancies: vacancies,
      city: city,
      area: area,
      payMin: payMin,
      payMax: payMax,
      payType: payType,
      minExperienceYears: minExperienceYears,
      maxExperienceYears: maxExperienceYears,
      shift: shift,
      neededBy: neededBy,
      benefits: benefits,
      requirements: requirements,
      matchSkillIds: matchSkillIds,
      untickedRelatedIds: untickedRelatedIds,
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
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
    String? description,
    String? shift,
    List<String>? benefits,
    List<String>? requirements,
  }) {
    createdAgency.add((
      title: title,
      city: city,
      area: area,
      payMin: payMin,
      payMax: payMax,
    ));
    agencyDescription = description;
    agencyShift = shift;
    agencyBenefits = benefits;
    agencyRequirements = requirements;
    return super.createAgencyJob(
      tradeKey: tradeKey,
      title: title,
      city: city,
      area: area,
      payMin: payMin,
      payMax: payMax,
      payType: payType,
      minExperienceYears: minExperienceYears,
      maxExperienceYears: maxExperienceYears,
      neededBy: neededBy,
      description: description,
      shift: shift,
      benefits: benefits,
      requirements: requirements,
    );
  }

  @override
  Future<JobPosting> updateJob(
    String id, {
    String? orgLabel,
    String? roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    String? status,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? shift,
    String? neededBy,
    List<String>? benefits,
    List<String>? requirements,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
  }) {
    patched.add((
      id: id,
      city: city,
      payMin: payMin,
      payMax: payMax,
      shift: shift,
      neededBy: neededBy,
      matchSkillIds: matchSkillIds,
    ));
    if (throwOnUpdate != null) throw throwOnUpdate!;
    return super.updateJob(
      id,
      orgLabel: orgLabel,
      roleTitle: roleTitle,
      locationLabel: locationLabel,
      description: description,
      vacancyBand: vacancyBand,
      vacancies: vacancies,
      status: status,
      city: city,
      area: area,
      payMin: payMin,
      payMax: payMax,
      payType: payType,
      minExperienceYears: minExperienceYears,
      maxExperienceYears: maxExperienceYears,
      shift: shift,
      neededBy: neededBy,
      benefits: benefits,
      requirements: requirements,
      matchSkillIds: matchSkillIds,
      untickedRelatedIds: untickedRelatedIds,
    );
  }
}

/// The same spy with Matching V1 LIVE, so the company path renders the demand
/// skill picker + the structured Shift / Needed-by selects — the inputs whose
/// values `POST /payer/job-postings` silently strips.
class _V1SpyApi extends _SpyApi {
  @override
  Future<List<MatchSkill>> fetchMatchSkills() async => const <MatchSkill>[
        MatchSkill(
          skillId: 'mskill_cnc_operate',
          label: 'CNC operating',
          industryId: 'ind_manufacturing',
        ),
      ];

  @override
  Future<ReachPreview> reachPreview({
    required List<String> matchSkillIds,
    List<String> untickedRelatedIds = const <String>[],
  }) async =>
      const ReachPreview(
        reachTotal: 12,
        reachTier1: 9,
        maxSkillsPerPosting: 5,
      );
}

/// The route as it behaved BEFORE #1653: `PayerCreateJobPostingSchema` stripped
/// the worker-visible content + match blocks and still answered 201. The user's
/// own API checkout can still be on that build, so the post flow's repair PATCH
/// has to keep working against it — this spy is what pins that.
class _OldRouteSpyApi extends _V1SpyApi {
  @override
  Future<JobPosting> createCompanyJob({
    required String orgLabel,
    required String roleTitle,
    String? locationLabel,
    String? description,
    String? vacancyBand,
    int? vacancies,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? shift,
    String? neededBy,
    List<String>? benefits,
    List<String>? requirements,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
  }) async {
    // Record the attempt exactly as the fixed spy does, then answer with a
    // draft that carries NONE of the stripped fields.
    final JobPosting draft = await super.createCompanyJob(
      orgLabel: orgLabel,
      roleTitle: roleTitle,
      locationLabel: locationLabel,
      description: description,
      vacancyBand: vacancyBand,
      vacancies: vacancies,
    );
    return draft;
  }
}

void main() {
  late _SpyApi api;

  Future<void> pump(WidgetTester tester, PayerRole role, {_SpyApi? spy}) async {
    await GetIt.instance.reset();
    api = spy ?? _SpyApi();
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

  // The posting's DISPLAY half (city / pay / shift / needed_by) is worker-visible
  // data, not a match input, so it must ride the post whether or not the
  // Matching-V1 routes are on. It used to be gated on the picker being live, so
  // a `MATCH_V1_ENABLED=false` server stored no wage and no timing for ANY
  // company posting — a worker saw a card with neither. This spy reports V1
  // UNAVAILABLE, which is exactly the case that used to drop everything.
  group('display fields are not gated on Matching V1', () {
    testWidgets('city, pay, shift and needed-by are posted with V1 off',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Job title', 'CNC Operator');
      await typeInto(tester, 'Location', 'Nashik');
      await typeInto(tester, 'Pay min ₹/mo', '18000');
      await typeInto(tester, 'Pay max ₹/mo', '24000');

      // Both selectors must EXIST with the picker off — they are on the
      // Pay, experience & timing card, not inside the V1 branch.
      await tester.tap(find.text('Night'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Immediately'));
      await tester.pumpAndSettle();

      await tapPost(tester);

      // They ride the CREATE itself (the route accepts them since #1653), so
      // the repair PATCH has nothing to land and makes no second call.
      expect(api.created, hasLength(1));
      expect(api.companyCity, 'Nashik');
      expect(api.companyPayMin, 18000);
      expect(api.companyPayMax, 24000);
      expect(api.companyShift, 'night');
      expect(api.companyNeededBy, 'immediate');
      expect(api.patched, isEmpty);
    });
  });

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

      // The description now folds ONLY what still has no column of its own:
      // the trade, and the free-text skills on the V1-off path. Pay and
      // experience are real fields since #1645/#1646, so repeating them in the
      // prose would print the same fact twice on the worker's card.
      final String description = created.description!;
      expect(description, contains('Trade: Quality Inspector'));
      expect(description, contains('Key skills: Fanuc'));
      expect(description, isNot(contains('Monthly pay')));
      expect(description, isNot(contains('Experience:')));
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

  group('agency — the worker-visible content reaches the create call', () {
    /// Add one chip through the '+ Add …' prompt (the only way in — there is no
    /// placeholder chip to edit).
    Future<void> addChip(
      WidgetTester tester, {
      required String addLabel,
      required Key fieldKey,
      required String phrase,
    }) async {
      await tester.tap(find.text(addLabel));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(fieldKey), phrase);
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();
    }

    testWidgets('description, shift, benefits and requirements are all sent', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'CNC Operator');
      await typeInto(tester, 'City', 'Pune');
      await typeInto(
        tester,
        'Description (optional)',
        'Turning job work on Fanuc controls. Two-shift plant.',
      );

      // Shift lives on the Timing card; null stays "Any shift".
      await tester.tap(find.text('Night'));
      await tester.pumpAndSettle();

      await addChip(
        tester,
        addLabel: '+ Add benefit',
        fieldKey: const Key('add-benefit-field'),
        phrase: 'PF + ESI',
      );
      await addChip(
        tester,
        addLabel: '+ Add requirement',
        fieldKey: const Key('add-requirement-field'),
        phrase: 'Fanuc control',
      );

      await tapPost(tester);

      expect(api.createdAgency, hasLength(1));
      // The whole point: the job card's four content fields used to have no
      // input at all, so none of this could ever reach a worker.
      expect(
        api.agencyDescription,
        'Turning job work on Fanuc controls. Two-shift plant.',
      );
      expect(api.agencyShift, 'night');
      expect(api.agencyBenefits, <String>['PF + ESI']);
      expect(api.agencyRequirements, <String>['Fanuc control']);
    });

    testWidgets('untouched content sends nothing — no filler, no empty lists', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'City', 'Pune');
      await tapPost(tester);

      expect(api.createdAgency, hasLength(1));
      expect(api.agencyDescription, isNull);
      expect(api.agencyShift, isNull);
      expect(api.agencyBenefits, isNull);
      expect(api.agencyRequirements, isNull);
    });

    testWidgets('a phone-shaped description is refused before the call', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'City', 'Pune');
      await typeInto(
        tester,
        'Description (optional)',
        'Call 98765 43210 for details',
      );
      await tapPost(tester);

      // Fail closed at entry: the server would 400 the whole post.
      expect(api.createdAgency, isEmpty);
      expect(find.text('Check the description'), findsOneWidget);
    });
  });

  group('company — an OLD server that drops the display fields is repaired',
      () {
    /// Fill the V1 company form: title + location + pay band + a demand skill +
    /// shift + needed-by.
    Future<void> fillV1Form(WidgetTester tester) async {
      await typeInto(tester, 'Job title', 'VMC Operator');
      await typeInto(tester, 'Location', 'Nashik');
      await typeInto(tester, 'Pay min ₹/mo', '22000');
      await typeInto(tester, 'Pay max ₹/mo', '28000');

      await tester.tap(find.text('CNC operating'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Day'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Immediately'));
      await tester.pumpAndSettle();
    }

    testWidgets('city, pay, shift, needed-by and skills ride a follow-up PATCH',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company, spy: _OldRouteSpyApi());
      await fillV1Form(tester);
      await tapPost(tester);

      expect(api.created, hasLength(1));
      // On that build the create strips every one of these, so without the
      // repair the posting lands with no pay band, no shift and — the real P0 —
      // no match skills, which means it reaches NO worker.
      expect(api.patched, hasLength(1));
      final patch = api.patched.single;
      expect(patch.city, 'Nashik');
      expect(patch.payMin, 22000);
      expect(patch.payMax, 28000);
      expect(patch.shift, 'day');
      expect(patch.neededBy, 'immediate');
      expect(patch.matchSkillIds, <String>['mskill_cnc_operate']);
    });

    testWidgets('a failed PATCH is reported, and the draft is NOT re-created', (
      WidgetTester tester,
    ) async {
      final _OldRouteSpyApi spy = _OldRouteSpyApi();
      spy.throwOnUpdate = const PayerApiException(500);
      await pump(tester, PayerRole.company, spy: spy);
      await fillV1Form(tester);
      await tapPost(tester);

      // Honest partial save: the draft exists, the details did not land, and we
      // say so instead of a bare "Job posted".
      expect(api.created, hasLength(1));
      expect(api.patched, hasLength(1));
      expect(
        find.textContaining('Draft saved, but the pay, shift and skills'),
        findsOneWidget,
      );
      // Re-posting would duplicate the draft on a non-idempotent route.
      expect(api.created, hasLength(1));
    });

    testWidgets('only the values the create dropped ride the PATCH', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company, spy: _OldRouteSpyApi());

      // An untouched pay band / location / shift / needed-by must not be
      // invented into the repair — only the picked skills were dropped.
      await typeInto(tester, 'Job title', 'Fitter');
      await tester.tap(find.text('CNC operating'));
      await tester.pumpAndSettle();
      await tapPost(tester);

      expect(api.created, hasLength(1));
      expect(api.patched, hasLength(1));
      expect(api.patched.single.city, isNull);
      expect(api.patched.single.payMin, isNull);
      expect(api.patched.single.shift, isNull);
      expect(
        api.patched.single.matchSkillIds,
        <String>['mskill_cnc_operate'],
      );
    });

    testWidgets('against the FIXED route the create carries them and no PATCH '
        'is made', (WidgetTester tester) async {
      // The mock client is faithful to the published route since #1653: the
      // create persists the content + match blocks and echoes them on the 201.
      // The repair is driven off that returned draft, so it must stay silent.
      await pump(tester, PayerRole.company, spy: _V1SpyApi());
      await fillV1Form(tester);
      await tapPost(tester);

      expect(api.created, hasLength(1));
      expect(api.patched, isEmpty);
      expect(find.textContaining('did not'), findsNothing);
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
