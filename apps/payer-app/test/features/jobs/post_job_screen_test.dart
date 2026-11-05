import 'dart:io' show SocketException;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/widgets/bb_action_bar.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/core/widgets/bb_shake.dart';
import 'package:payer_app/core/widgets/bb_step_progress.dart';
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

/// One of the 16 postable trades, as `GET /payer/posting-trades` serves it —
/// no rung or chips, so picking it seeds just the trade's own match skill.
const PostingTradeForm _welder = PostingTradeForm(
  roleKind: 'welder',
  roleLabel: 'Welder',
  packId: 'qp_welding_trade',
  matchSkillId: 'mskill_welder',
);

/// The catalogue a company form is served (#2635 — a company job cannot be
/// posted without one of the 16 trades).
const List<PostingTradeForm> _companyTrades = <PostingTradeForm>[_welder];

/// Captures every create call so the test can assert what actually rides the
/// wire (the mock base returns a canned draft posting).
class _SpyApi extends MockPayerApiClient {
  _SpyApi({this.trades = const <PostingTradeForm>[]});

  /// The 16-trade catalogue this server answers with. EMPTY by default — the
  /// agency form's trade-less fallback; company tests are served
  /// [_companyTrades] (see `pump`).
  final List<PostingTradeForm> trades;

  /// When set, the NEXT catalogue read throws it (a Retry then succeeds).
  Object? throwOnTradesOnce;

  final List<
      ({
        String org,
        String title,
        String? location,
        String? description,
        String? band
      })> created = <({
    String org,
    String title,
    String? location,
    String? description,
    String? band
  })>[];

  final List<
          ({String title, String city, String? area, int? payMin, int? payMax})>
      createdAgency =
      <({String title, String city, String? area, int? payMin, int? payMax})>[];

  /// The worker-visible content of the last agency create — the four fields the
  /// job card renders verbatim and the form used to have no input for.
  String? agencyDescription;
  String? agencyShift;
  List<String>? agencyBenefits;
  List<String>? agencyRequirements;
  List<String>? agencyMatchSkillIds;

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

  /// The trade half of the last COMPANY create (#2635).
  String? companyRoleKind;
  String? companyTradeLevel;
  Map<String, List<String>>? companyTradeAnswers;
  List<String>? companyMatchSkillIds;

  /// When set, every [updateJob] throws it — the partial-save path.
  Object? throwOnUpdate;

  /// When set, both creates throw it (after recording the call) — the server
  /// refusing the post.
  Object? throwOnCreate;

  // Matching V1's flat vocabulary is off on this server (the route answers
  // nothing); [_V1SpyApi] turns it on.
  @override
  Future<List<MatchSkill>> fetchMatchSkills() async => const <MatchSkill>[];

  @override
  Future<List<PostingTradeForm>> fetchPostingTrades() async {
    final Object? error = throwOnTradesOnce;
    if (error != null) {
      throwOnTradesOnce = null;
      throw error;
    }
    return trades;
  }

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
    String? roleKind,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
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
    companyRoleKind = roleKind;
    companyTradeLevel = tradeLevel;
    companyTradeAnswers = tradeAnswers;
    companyMatchSkillIds = matchSkillIds;
    if (throwOnCreate != null) throw throwOnCreate!;
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
      roleKind: roleKind,
      benefits: benefits,
      requirements: requirements,
      tradeLevel: tradeLevel,
      tradeAnswers: tradeAnswers,
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
    String? roleKind,
    String? description,
    String? shift,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
    List<String>? matchSkillIds,
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
    agencyMatchSkillIds = matchSkillIds;
    if (throwOnCreate != null) throw throwOnCreate!;
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
      roleKind: roleKind,
      description: description,
      shift: shift,
      benefits: benefits,
      requirements: requirements,
      tradeLevel: tradeLevel,
      tradeAnswers: tradeAnswers,
      matchSkillIds: matchSkillIds,
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
    String? roleKind,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
    List<String>? matchSkillIds,
    List<String>? untickedRelatedIds,
    List<JobPostingClearField>? clear,
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
      tradeLevel: tradeLevel,
      tradeAnswers: tradeAnswers,
      matchSkillIds: matchSkillIds,
      untickedRelatedIds: untickedRelatedIds,
    );
  }
}

/// The same spy with Matching V1 LIVE: the agency form renders the flat demand
/// skill picker, and the company form sends its trade's match skills — the
/// values `POST /payer/job-postings` once silently stripped.
class _V1SpyApi extends _SpyApi {
  _V1SpyApi({super.trades = const <PostingTradeForm>[]});

  @override
  Future<List<MatchSkill>> fetchMatchSkills() async => const <MatchSkill>[
        MatchSkill(
          skillId: 'mskill_cnc_operate',
          label: 'CNC operating',
          industryId: 'ind_manufacturing',
        ),
      ];

  /// The `role_kind` of every reach preview asked for (#2635).
  final List<String?> reachRoleKinds = <String?>[];

  @override
  Future<ReachPreview> reachPreview({
    required List<String> matchSkillIds,
    List<String> untickedRelatedIds = const <String>[],
    String? roleKind,
  }) async {
    reachRoleKinds.add(roleKind);
    return const ReachPreview(
      reachTotal: 12,
      reachTier1: 9,
      maxSkillsPerPosting: 5,
    );
  }
}

/// The route as it behaved BEFORE #1653: `PayerCreateJobPostingSchema` stripped
/// the worker-visible content + match blocks and still answered 201. The user's
/// own API checkout can still be on that build, so the post flow's repair PATCH
/// has to keep working against it — this spy is what pins that.
class _OldRouteSpyApi extends _V1SpyApi {
  _OldRouteSpyApi() : super(trades: _companyTrades);

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
    String? roleKind,
    List<String>? benefits,
    List<String>? requirements,
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
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

/// A one-role trade catalogue whose five match chips, with the role's base
/// skill, come to one more than the fallback cap of five match skills.
final PostingTradeForm _capTrade = PostingTradeForm(
  roleKind: 'fitter',
  roleLabel: 'Fitter',
  packId: 'pack_fitter',
  matchSkillId: 'mskill_fitting',
  questions: <PostingTradeQuestion>[
    PostingTradeQuestion(
      questionKey: 'machines',
      prompt: 'Machines run',
      answerType: 'multi_select',
      options: <PostingTradeOption>[
        for (int i = 1; i <= 5; i++)
          PostingTradeOption(
            optionKey: 'm$i',
            value: 'm$i',
            label: 'Machine $i',
            match: true,
            matchSkillIds: <String>['mskill_m$i'],
          ),
      ],
    ),
  ],
);

/// [_SpyApi] with the trade catalogue on (the 16-trade form path).
class _TradeSpyApi extends _SpyApi {
  @override
  Future<List<PostingTradeForm>> fetchPostingTrades() async =>
      <PostingTradeForm>[_capTrade];
}

void main() {
  late _SpyApi api;

  /// How many times the screen asked its host to close it.
  int backs = 0;

  Future<void> pump(
    WidgetTester tester,
    PayerRole role, {
    _SpyApi? spy,
    Size size = const Size(1000, 4000),
  }) async {
    await GetIt.instance.reset();
    // A company form is served the 16-trade catalogue (it cannot post without
    // one, #2635); the agency default keeps its trade-less fallback.
    api = spy ??
        _SpyApi(
          trades: role == PayerRole.company
              ? _companyTrades
              : const <PostingTradeForm>[],
        );
    backs = 0;
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
    locator<AppSessionCubit>().signIn(role);

    // The form is taller than the default 600px test viewport. A tall viewport
    // shows EVERY field, which both lets us reach 'Post job' without scrolling
    // and keeps every tap a real hit. (#2595 tests that need scrolling pass a
    // phone-sized [size].)
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: PostJobScreen(onBack: () => backs++)),
      ),
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

  /// Tap an enum chip by its visible label.
  Future<void> tapChip(WidgetTester tester, String label) async {
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  /// Pick the company job's trade from the 16-trade role picker (#2635).
  Future<void> pickTrade(WidgetTester tester, [String label = 'Welder']) async {
    await tester.tap(find.text('— pick the role —'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  /// [text] shown AT the company trade picker (inside the role's anchor).
  Finder atTradePicker(String text) => find.descendant(
        of: find.ancestor(of: find.text('Role'), matching: find.byType(BbShake)),
        matching: find.text(text),
      );

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

  /// Fill EVERY field the worker's job card renders, on either branch.
  ///
  /// The card draws the place (city + optional area), the ₹ band, what that
  /// band MEANS, the experience window, the shift, the needed-by chip, the
  /// description and the two chip rows — so the form refuses to post until all
  /// of them are set, and a test that posts must set all of them. `neededBy`
  /// differs by branch only in its LABEL ('Immediately' vs 'Immediate'); the
  /// value on the wire is `immediate` either way.
  Future<void> fillCardContent(
    WidgetTester tester, {
    String city = 'Pune',
    String payMin = '18000',
    String payMax = '24000',
    String expMin = '1',
    String expMax = '4',
    String payType = 'In-hand',
    String shift = 'Night',
    String neededBy = 'Immediately',
    String description = 'Turning job work on Fanuc controls.',
    String benefit = 'PF + ESI',
    String requirement = 'Fanuc control',
  }) async {
    await typeInto(tester, 'City', city);
    await typeInto(tester, 'Pay min ₹/mo', payMin);
    await typeInto(tester, 'Pay max ₹/mo', payMax);
    await typeInto(tester, 'Exp min (yrs)', expMin);
    await typeInto(tester, 'Exp max (yrs)', expMax);
    await typeInto(tester, 'Description', description);
    await tapChip(tester, payType);
    await tapChip(tester, shift);
    await tapChip(tester, neededBy);
    await addChip(
      tester,
      addLabel: '+ Add benefit',
      fieldKey: const Key('add-benefit-field'),
      phrase: benefit,
    );
    await addChip(
      tester,
      addLabel: '+ Add requirement',
      fieldKey: const Key('add-requirement-field'),
      phrase: requirement,
    );
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
      await pickTrade(tester);
      // Both selectors must EXIST with the picker off — they are on the
      // Pay, experience & timing card, not inside the V1 branch.
      await fillCardContent(tester, city: 'Nashik');

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

    // #2635 — the company form's role is the TRADE, from the 16-trade
    // catalogue; the free 27-role "illustration" select and the optional free
    // trade list it fell back to are gone (a job posted with them could never
    // go live) — even on a server whose catalogue answers nothing.
    testWidgets('company form asks for the trade, never a free trade or role',
        (WidgetTester tester) async {
      // A server whose catalogue answers nothing — where the old form fell
      // back to both free lists.
      await pump(tester, PayerRole.company, spy: _SpyApi());
      expect(find.text('Role'), findsOneWidget);
      expect(find.text('Role (card illustration)'), findsNothing);
      expect(find.text('Trade (optional)'), findsNothing);
    });

    testWidgets('agency form asks for the worker-card role illustration',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.agency);
      expect(find.text('Role (card illustration)'), findsOneWidget);
    });

    testWidgets('untouched company form posts nothing', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await tapPost(tester);

      // The old screen posted 'CNC Setter' @ 'Pimpri, Pune' right here.
      expect(api.created, isEmpty);
      // #2595 — named AT the field (the org is the signed-in account's).
      expect(find.text('Add the job title'), findsOneWidget);
      expect(find.text('Add the company name'), findsNothing);
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
    // #2635 — the trade now rides its own fields (`role_kind` + the trade
    // form), so nothing is folded into the description any more: it is the
    // payer's own words, exactly.
    testWidgets('the trade rides role_kind + its trade form, not `description`',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Job title', 'VMC Operator');
      await typeInto(tester, 'Location note (optional, not shown to workers)',
          'Nashik MIDC');
      await pickTrade(tester);
      await fillCardContent(
        tester,
        city: 'Nashik',
        payMin: '22000',
        payMax: '28000',
        expMin: '2',
        expMax: '6',
        description: 'Setting and running VMC machines.',
      );

      await tapPost(tester);

      expect(api.created, hasLength(1));
      final created = api.created.single;
      expect(created.title, 'VMC Operator');
      // `location_label` is the payer's own note and stays SEPARATE from the
      // city — the worker feed never reads it.
      expect(created.location, 'Nashik MIDC');
      expect(api.companyCity, 'Nashik');
      expect(created.org, 'Kalyani Industries');

      // One of the 16 trades, and its trade form — untouched, so `{}`: the
      // server derives the match set from the trade, never a client list.
      expect(api.companyRoleKind, 'welder');
      expect(api.companyTradeAnswers, <String, List<String>>{});
      expect(api.companyTradeLevel, isNull);

      // The payer's own words, and nothing folded in beside them.
      expect(created.description, 'Setting and running VMC machines.');
    });

    testWidgets('a blank description is refused — the card renders one', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await typeInto(tester, 'Job title', 'Fitter');
      await fillCardContent(tester, description: '');
      await tapPost(tester);

      expect(api.created, isEmpty);
      expect(find.text('Add the description'), findsOneWidget);
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
    testWidgets('description, shift, benefits and requirements are all sent', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'Lathe hand');
      // The trade is the card's own trade line — no longer defaulted.
      await tapChip(tester, 'CNC / VMC Setter');
      await fillCardContent(
        tester,
        neededBy: 'Immediate',
        description: 'Turning job work on Fanuc controls. Two-shift plant.',
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
      expect(api.createdAgency.single.city, 'Pune');
    });

    testWidgets('an untouched content block is REFUSED — the card needs it', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'Fitter');
      await tapChip(tester, 'CNC / VMC Setter');
      await typeInto(tester, 'City', 'Pune');
      await tapPost(tester);

      // It used to post a job whose card had no wage, no shift and no chips.
      expect(api.createdAgency, isEmpty);
      expect(find.text('Add the pay band'), findsOneWidget);
    });

    testWidgets('a phone-shaped description is refused before the call', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'Fitter');
      await tapChip(tester, 'CNC / VMC Setter');
      await fillCardContent(
        tester,
        neededBy: 'Immediate',
        description: 'Call 98765 43210 for details',
      );
      await tapPost(tester);

      // Fail closed at entry: the server would 400 the whole post. #2595 —
      // the reason sits at the description, not in a toast.
      expect(api.createdAgency, isEmpty);
      expect(
        find.text(
          'Leave phone numbers and email addresses out of the description.',
        ),
        findsOneWidget,
      );
    });

    // #1960 — the picker is no longer company-only: an agency job's
    // `match_skill_ids` is the field ADR-0050's twin is served on.
    testWidgets('the demand-skill pick rides the agency create (V1 live)', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency, spy: _V1SpyApi());

      await typeInto(tester, 'Job title', 'Lathe hand');
      await tapChip(tester, 'CNC / VMC Setter');
      await fillCardContent(
        tester,
        neededBy: 'Immediate',
        description: 'Turning job work on Fanuc controls.',
      );

      expect(find.text('Skills this role needs'), findsOneWidget);
      await tester.tap(find.text('CNC operating'));
      await tester.pumpAndSettle();
      await tapPost(tester);

      expect(api.createdAgency, hasLength(1));
      expect(api.agencyMatchSkillIds, <String>['mskill_cnc_operate']);
    });
  });

  group('company — an OLD server that drops the display fields is repaired',
      () {
    /// Fill the V1 company form: title + the trade (which seeds its own match
    /// skill, #2635) + pay band + shift + needed-by.
    Future<void> fillV1Form(WidgetTester tester) async {
      await typeInto(tester, 'Job title', 'VMC Operator');
      await pickTrade(tester);
      await fillCardContent(
        tester,
        city: 'Nashik',
        payMin: '22000',
        payMax: '28000',
        shift: 'Day',
      );
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
      expect(patch.matchSkillIds, <String>['mskill_welder']);
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

    testWidgets('the Location note never becomes the city', (
      WidgetTester tester,
    ) async {
      // The company form had NO city input: `_submit` reused the free-text
      // Location box, so "Plot 42, MIDC Chakan" was stored as the city and a
      // blank one published a posting with none at all.
      await pump(
        tester,
        PayerRole.company,
        spy: _V1SpyApi(trades: _companyTrades),
      );

      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'Location note (optional, not shown to workers)',
          'Plot 42, MIDC Chakan');
      await pickTrade(tester);
      await fillCardContent(tester, city: 'Pune');
      await tapPost(tester);

      expect(api.created, hasLength(1));
      expect(api.companyCity, 'Pune');
      expect(api.created.single.location, 'Plot 42, MIDC Chakan');
    });

    testWidgets(
        'against the FIXED route the create carries them and no PATCH '
        'is made', (WidgetTester tester) async {
      // The mock client is faithful to the published route since #1653: the
      // create persists the content + match blocks and echoes them on the 201.
      // The repair is driven off that returned draft, so it must stay silent.
      await pump(
        tester,
        PayerRole.company,
        spy: _V1SpyApi(trades: _companyTrades),
      );
      await fillV1Form(tester);
      await tapPost(tester);

      expect(api.created, hasLength(1));
      expect(api.patched, isEmpty);
      expect(find.textContaining('did not'), findsNothing);
    });
  });

  /// EVERY FACT THE WORKER'S CARD SHOWS MUST COME FROM THIS FORM. Each field
  /// below was optional, and an unstated one is a HOLE on the card — the city
  /// especially, which the feed serves as "" and the card draws as a bare
  /// location pin with nothing beside it.
  group('every field the worker card shows is required', () {
    testWidgets('company — a blank city is refused', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Job title', 'Fitter');
      await fillCardContent(tester, city: '');
      await tapPost(tester);

      expect(api.created, isEmpty);
      expect(find.text('Add the city'), findsOneWidget);
    });

    testWidgets('agency — a blank city is refused', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'Fitter');
      await tapChip(tester, 'CNC / VMC Setter');
      await fillCardContent(tester, city: '', neededBy: 'Immediate');
      await tapPost(tester);

      expect(api.createdAgency, isEmpty);
      expect(find.text('Add the city'), findsOneWidget);
    });

    testWidgets('agency — an unpicked trade is refused, never defaulted', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      await typeInto(tester, 'Job title', 'Fitter');
      await fillCardContent(tester, neededBy: 'Immediate');
      await tapPost(tester);

      // It used to default to the FIRST trade, so an agency that never chose
      // one still advertised 'CNC Operator' on the worker's card.
      expect(api.createdAgency, isEmpty);
      expect(find.text('Pick the trade'), findsOneWidget);
    });

    testWidgets('company — an unpicked pay type is refused', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'City', 'Pune');
      await typeInto(tester, 'Pay min ₹/mo', '18000');
      await typeInto(tester, 'Pay max ₹/mo', '24000');
      await tapPost(tester);

      // "kitna haath me aayega" — the band alone does not answer it.
      expect(api.created, isEmpty);
      expect(find.text('Pick the pay type'), findsOneWidget);
    });

    testWidgets('company — a missing experience window is refused', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Job title', 'Fitter');
      await fillCardContent(tester, expMax: '');
      await tapPost(tester);

      expect(api.created, isEmpty);
      expect(find.text('Add the experience'), findsOneWidget);
    });

    testWidgets('company — an empty requirement row is refused', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'City', 'Pune');
      await typeInto(tester, 'Pay min ₹/mo', '18000');
      await typeInto(tester, 'Pay max ₹/mo', '24000');
      await typeInto(tester, 'Exp min (yrs)', '1');
      await typeInto(tester, 'Exp max (yrs)', '4');
      await typeInto(tester, 'Description', 'Fitting work on site.');
      await tapChip(tester, 'In-hand');
      await tapChip(tester, 'Night');
      await tapChip(tester, 'Immediately');
      await addChip(
        tester,
        addLabel: '+ Add benefit',
        fieldKey: const Key('add-benefit-field'),
        phrase: 'PF + ESI',
      );
      await tapPost(tester);

      expect(api.created, isEmpty);
      expect(find.text('Add a requirement'), findsOneWidget);
    });

    testWidgets('no enum chip starts selected — nothing lands unchosen', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);

      // The old form preselected the first trade AND the first needed-by, so
      // both reached the card without the payer ever tapping them.
      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'City', 'Pune');
      await tapPost(tester);

      expect(api.createdAgency, isEmpty);
      // Both are refused at their own chips (#2595).
      expect(find.text('Pick the trade'), findsOneWidget);
      expect(find.text('Pick needed by'), findsOneWidget);
    });
  });

  // #357 — a chip is only ever a phrase the payer typed (the old '+ Add skill'
  // inserted the placeholder 'Skill N'). The company form's free-text "Key
  // skills" are gone (#2635 — its skills come from its trade), so the shared
  // prompt is pinned on the Benefits row it still serves.
  group('#357 — a chip prompt asks for the real phrase', () {
    testWidgets('adds the typed phrase, never a placeholder', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);

      await tester.tap(find.text('+ Add benefit'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('add-benefit-field')),
        'Canteen on site',
      );
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();

      expect(find.text('Canteen on site'), findsOneWidget);
      expect(find.text('Benefit 1'), findsNothing);
    });

    testWidgets('a phone-shaped phrase is refused at entry (no PII on the wire)',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company);

      await tester.tap(find.text('+ Add benefit'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('add-benefit-field')),
        'call 98765 43210',
      );
      await tester.tap(find.text('Add'));
      await tester.pumpAndSettle();

      // #2595 — refused INSIDE the dialog, under the box, with the text kept
      // so the payer can fix it (it used to close and toast).
      expect(
        find.text('Leave phone numbers and email addresses out of a posting.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      // Never a chip — no PII on the wire.
      expect(find.text('call 98765 43210'), findsNothing);
    });
  });

  // ---------------------------------------------------------------------------
  // #2595 (M7) — inline errors, the reveal, number boxes, keyboard flow, the
  // pinned bar, the progress bar and the unsaved-changes guard.
  // ---------------------------------------------------------------------------
  group('#2595 — forms', () {
    late List<String> haptics;

    setUp(() {
      haptics = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform,
              (MethodCall call) async {
        if (call.method == 'HapticFeedback.vibrate') {
          haptics.add(call.arguments as String);
        }
        return null;
      });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    /// The [TextField] of the box labelled [label].
    Finder boxOf(String label) => find.descendant(
          of: find
              .ancestor(of: find.text(label), matching: find.byType(Column))
              .first,
          matching: find.byType(TextField),
        );

    bool focused(WidgetTester tester, String label) => tester
        .widget<EditableText>(
          find.descendant(of: boxOf(label), matching: find.byType(EditableText)),
        )
        .focusNode
        .hasFocus;

    testWidgets('a refused post shows EVERY reason at its field — no toast', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await tapPost(tester);

      expect(api.created, isEmpty);
      for (final String error in <String>[
        'Add the job title',
        'Add the city',
        'Add the pay band',
        'Pick the pay type',
        'Add the experience',
        'Pick the shift',
        'Pick needed by',
        'Add the description',
        'Add a benefit',
        'Add a requirement',
      ]) {
        expect(find.text(error), findsOneWidget, reason: error);
      }
      // The six toast branches are gone.
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('fixing a field clears its error; a new one waits for Post', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await tapPost(tester);
      expect(find.text('Add the job title'), findsOneWidget);

      await typeInto(tester, 'Job title', 'Fitter');
      await tester.pumpAndSettle();
      expect(find.text('Add the job title'), findsNothing);
      // The others are untouched — and still on show.
      expect(find.text('Add the city'), findsOneWidget);

      // A pick fixes its own error at once…
      await tapChip(tester, 'Night');
      expect(find.text('Pick the shift'), findsNothing);
      // …raising "Pay min" fixes "Max pay" (an error from another box)…
      await typeInto(tester, 'Pay min ₹/mo', '30000');
      await typeInto(tester, 'Pay max ₹/mo', '20000');
      await tapPost(tester);
      expect(find.text('Max pay must be at least the min.'), findsOneWidget);
      await typeInto(tester, 'Pay min ₹/mo', '18000');
      await tester.pumpAndSettle();
      expect(find.text('Max pay must be at least the min.'), findsNothing);

      // …and emptying the title again does not nag until the next Post.
      await typeInto(tester, 'Job title', '');
      await tester.pumpAndSettle();
      expect(find.text('Add the job title'), findsNothing);
      await tapPost(tester);
      expect(find.text('Add the job title'), findsOneWidget);
    });

    testWidgets(
        'a refused post scrolls to the FIRST invalid field, shakes it and '
        'fires the error haptic', (WidgetTester tester) async {
      await pump(tester, PayerRole.company, size: const Size(400, 800));
      // The top of the form is fine; the pay band (mid-form) is the first gap.
      await typeInto(tester, 'Job title', 'Fitter');
      await pickTrade(tester);
      await typeInto(tester, 'City', 'Pune');
      // Scroll to the very end of the form.
      await tester.drag(
        find.byType(SingleChildScrollView),
        const Offset(0, -6000),
      );
      await tester.pumpAndSettle();
      final Rect viewport =
          tester.getRect(find.byType(SingleChildScrollView));
      expect(
        tester.getRect(find.text('Pay min ₹/mo')).bottom,
        lessThan(viewport.top),
      );
      haptics.clear();

      await tester.tap(find.text('Post job'));
      double maxShake = 0;
      for (int i = 0; i < 60; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        final Finder shake = find.ancestor(
          of: find.text('Pay min ₹/mo'),
          matching: find.byType(BbShake),
        );
        final double dx = tester
            .widget<Transform>(
              find.descendant(of: shake, matching: find.byType(Transform)).first,
            )
            .transform
            .getTranslation()
            .x
            .abs();
        if (dx > maxShake) maxShake = dx;
      }

      // The first invalid field is on screen with its reason under it…
      final Rect payMin = tester.getRect(find.text('Pay min ₹/mo'));
      expect(payMin.top, greaterThanOrEqualTo(viewport.top));
      expect(payMin.bottom, lessThanOrEqualTo(viewport.bottom));
      expect(find.text('Add the pay band'), findsOneWidget);
      // …it shook 6px…
      expect(maxShake, closeTo(AppMotion.shakeTravel, 0.6));
      // …and ONE light error tick followed the button's own tap.
      const String light = 'HapticFeedbackType.lightImpact';
      expect(haptics, <String>[light, light]);
      expect(api.created, isEmpty);
    });

    // The device screens only phone and email shapes; the server also refuses
    // a company name and a link in the worker-visible text
    // (`screenWorkerVisibleText`). Its 400 names each field.
    Future<void> fillAgencyPost(WidgetTester tester) async {
      await typeInto(tester, 'Job title', 'Lathe hand');
      await tapChip(tester, 'CNC / VMC Setter');
      await typeInto(tester, 'Area (optional)', 'Tata Motors Pvt Ltd');
      await fillCardContent(
        tester,
        neededBy: 'Immediate',
        description: 'Apply at tatamotors.com',
      );
    }

    testWidgets(
        "the server's refusal shows AT its fields and stays until that field "
        'changes', (WidgetTester tester) async {
      await pump(tester, PayerRole.agency);
      await fillAgencyPost(tester);
      api.throwOnCreate = const PayerApiException(
        400,
        validationMessage: 'Description: Must not contain links.',
        fieldErrors: <String, String>{
          'description': 'Must not contain links.',
          'area': 'Must not contain a company name.',
        },
      );
      haptics.clear();

      await tapPost(tester);
      await tester.pumpAndSettle();

      expect(api.createdAgency, hasLength(1));
      expect(find.text('Must not contain links.'), findsOneWidget);
      expect(find.text('Must not contain a company name.'), findsOneWidget);
      // Each at its own box, not a toast that names no field…
      expect(
        find.descendant(
          of: find.ancestor(
            of: find.text('Area (optional)'),
            matching: find.byType(BbShake),
          ),
          matching: find.text('Must not contain a company name.'),
        ),
        findsOneWidget,
      );
      expect(find.byType(SnackBar), findsNothing);
      // …with ONE light error tick after the button's own.
      const String light = 'HapticFeedbackType.lightImpact';
      expect(haptics, <String>[light, light]);

      // An edit elsewhere leaves both on show…
      await typeInto(tester, 'Job title', 'Lathe operator');
      await tester.pumpAndSettle();
      expect(find.text('Must not contain links.'), findsOneWidget);
      expect(find.text('Must not contain a company name.'), findsOneWidget);

      // …changing THE field clears its own.
      await typeInto(tester, 'Description', 'Turning work on Fanuc controls.');
      await tester.pumpAndSettle();
      expect(find.text('Must not contain links.'), findsNothing);
      expect(find.text('Must not contain a company name.'), findsOneWidget);

      // A standing refusal never blocks the next Post: the server judges it.
      api.throwOnCreate = null;
      await tapPost(tester);
      expect(api.createdAgency, hasLength(2));
    });

    testWidgets("a company post's refused title shows at the title", (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await typeInto(tester, 'Job title', 'Setter at Acme Pvt Ltd');
      await pickTrade(tester);
      await fillCardContent(tester);
      api.throwOnCreate = const PayerApiException(
        400,
        validationMessage: 'Title must not contain a company name',
        fieldErrors: <String, String>{
          'role_title': 'Title must not contain a company name.',
        },
      );

      await tapPost(tester);
      await tester.pumpAndSettle();

      expect(api.created, hasLength(1));
      expect(
        find.descendant(
          of: find.ancestor(
            of: find.text('Job title'),
            matching: find.byType(BbShake),
          ),
          matching: find.text('Title must not contain a company name.'),
        ),
        findsOneWidget,
      );
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('a refusal that names no box still says the real reason', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);
      await fillAgencyPost(tester);
      // A service-thrown 400: a message, no field issue.
      api.throwOnCreate = const PayerApiException(
        400,
        validationMessage: 'A posting may name at most 3 skills (got 4).',
      );

      await tapPost(tester);

      expect(
        find.descendant(
          of: find.byType(SnackBar),
          matching: find.text('A posting may name at most 3 skills (got 4).'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a bare 400 names the three things the server screens', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);
      await fillAgencyPost(tester);
      api.throwOnCreate = const PayerApiException(400);

      await tapPost(tester);

      expect(
        find.text('The server rejected these details. Take out any phone '
            'number, email address, company name or link.'),
        findsOneWidget,
      );
    });

    testWidgets('pay boxes: digits only, ₹ prefix, grouped; experience digits',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company);

      await typeInto(tester, 'Pay min ₹/mo', '18000');
      final TextField payMin = tester.widget<TextField>(boxOf('Pay min ₹/mo'));
      expect(payMin.controller!.text, '18,000');
      expect(payMin.decoration!.prefixText, '₹ ');
      expect(payMin.keyboardType, TextInputType.number);

      await typeInto(tester, 'Pay max ₹/mo', 'Rs 1,25,000/-');
      expect(
        tester.widget<TextField>(boxOf('Pay max ₹/mo')).controller!.text,
        '1,25,000',
      );

      await typeInto(tester, 'Exp min (yrs)', '2 yrs');
      expect(
        tester.widget<TextField>(boxOf('Exp min (yrs)')).controller!.text,
        '2',
      );

      // The grouped value still posts as a whole number.
      await typeInto(tester, 'Job title', 'Fitter');
      await pickTrade(tester);
      await fillCardContent(tester, payMin: '18000', payMax: '125000');
      await tapPost(tester);
      expect(api.companyPayMin, 18000);
      expect(api.companyPayMax, 125000);
    });

    testWidgets('the keyboard "next" walks the text boxes; "done" ends it', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      const List<String> chain = <String>[
        'Company / org name',
        'Job title',
        'City',
        'Area (optional)',
        'Location note (optional, not shown to workers)',
        'Pay min ₹/mo',
        'Pay max ₹/mo',
        'Exp min (yrs)',
        'Exp max (yrs)',
      ];
      for (final String label in chain.take(chain.length - 1)) {
        expect(
          tester.widget<TextField>(boxOf(label)).textInputAction,
          TextInputAction.next,
          reason: label,
        );
      }
      expect(
        tester.widget<TextField>(boxOf('Exp max (yrs)')).textInputAction,
        TextInputAction.done,
      );

      await tester.tap(boxOf(chain.first));
      await tester.pump();
      for (int i = 1; i < chain.length; i++) {
        await tester.testTextInput.receiveAction(TextInputAction.next);
        await tester.pump();
        expect(focused(tester, chain[i]), isTrue, reason: chain[i]);
      }
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(focused(tester, 'Exp max (yrs)'), isFalse);
    });

    testWidgets('a drag on the form closes the keyboard', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company, size: const Size(400, 800));
      await tester.tap(boxOf('Company / org name'));
      await tester.pump();
      expect(focused(tester, 'Company / org name'), isTrue);

      await tester.drag(
        find.byType(SingleChildScrollView),
        const Offset(0, -300),
      );
      await tester.pumpAndSettle();
      expect(focused(tester, 'Company / org name'), isFalse);
    });

    testWidgets('Post sits in the shared pinned action bar', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      final Scaffold scaffold = tester.widget<Scaffold>(find.descendant(
        of: find.byType(PostJobScreen),
        matching: find.byType(Scaffold),
      ));
      expect(scaffold.bottomNavigationBar, isA<BbActionBar>());
      expect(
        find.descendant(
          of: find.byType(BbActionBar),
          matching: find.text('Post job'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('the progress bar counts the four sections as they complete', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      // Nothing is done on an untouched form: the skills section is the
      // picked trade's own form, so it waits for the trade (#2635).
      expect(find.text('0 of 4 sections done'), findsOneWidget);

      // Picking the trade completes it (the trade carries its own skill)…
      await pickTrade(tester);
      expect(find.text('1 of 4 sections done'), findsOneWidget);

      // …and the title + city complete the first.
      await typeInto(tester, 'Job title', 'Fitter');
      await typeInto(tester, 'City', 'Pune');
      expect(find.text('2 of 4 sections done'), findsOneWidget);
      // The bar FILLS to the new step over 300ms (transform only).
      double fill() => tester
          .widget<Transform>(find.byKey(BbStepProgress.fillKey))
          .transform
          .storage[0];
      await tester.pump(const Duration(milliseconds: 150));
      expect(fill(), inExclusiveRange(0.25, 0.5));
      await tester.pumpAndSettle();
      expect(fill(), 0.5);

      await fillCardContent(tester, city: 'Pune');
      await tester.pumpAndSettle();
      expect(find.text('4 of 4 sections done'), findsOneWidget);
      expect(fill(), 1);
    });

    testWidgets('Back on an untouched form leaves at once', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await tester.tap(find.byIcon(Icons.arrow_back_rounded));
      await tester.pumpAndSettle();
      expect(backs, 1);
      expect(find.text('Discard this job?'), findsNothing);
    });

    testWidgets('Back on a filled-in form asks before discarding it', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company);
      await typeInto(tester, 'Job title', 'Fitter');

      await tester.tap(find.byIcon(Icons.arrow_back_rounded));
      await tester.pumpAndSettle();
      expect(find.text('Discard this job?'), findsOneWidget);
      await tester.tap(find.text('Keep editing'));
      await tester.pumpAndSettle();
      expect(backs, 0);
      expect(find.widgetWithText(TextField, 'Fitter'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.arrow_back_rounded));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();
      expect(backs, 1);
    });

    testWidgets('a chip pick alone counts as unsaved input', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.agency);
      await tapChip(tester, 'Night');
      await tester.tap(find.byIcon(Icons.arrow_back_rounded));
      await tester.pumpAndSettle();
      expect(find.text('Discard this job?'), findsOneWidget);
    });

    testWidgets(
        'a match chip past the cap is refused under the chips — not a toast',
        (WidgetTester tester) async {
      await pump(tester, PayerRole.company, spy: _TradeSpyApi());
      await tester.tap(find.text('— pick the role —'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Fitter').last);
      await tester.pumpAndSettle();

      for (int i = 1; i <= 4; i++) {
        await tapChip(tester, 'Machine $i · Match');
      }
      expect(find.textContaining('Pick up to 5 match skills'), findsNothing);
      haptics.clear();

      // Base skill + five chips = six: one past the cap of five.
      await tapChip(tester, 'Machine 5 · Match');
      expect(
        find.text(
          'Pick up to 5 match skills — the rest are requirements and do not '
          'change reach.',
        ),
        findsOneWidget,
      );
      expect(find.byType(SnackBar), findsNothing);
      await tester.pump(const Duration(milliseconds: 100));
      // The chip's own tap, then the error double tick.
      const String light = 'HapticFeedbackType.lightImpact';
      expect(haptics, <String>[light, light, light]);

      // The next accepted change clears it.
      await tapChip(tester, 'Machine 4 · Match');
      expect(find.textContaining('Pick up to 5 match skills'), findsNothing);
    });

    testWidgets(
        'Post is not a dead button — a company job with no trade is refused '
        'AT the trade picker (#2635)', (WidgetTester tester) async {
      await pump(
        tester,
        PayerRole.company,
        spy: _V1SpyApi(trades: _companyTrades),
      );
      final FilledButton post = tester.widget<FilledButton>(find.ancestor(
        of: find.text('Post job'),
        matching: find.byType(FilledButton),
      ));
      expect(post.onPressed, isNotNull);

      await typeInto(tester, 'Job title', 'Fitter');
      await fillCardContent(tester);
      await tapPost(tester);
      await tester.pumpAndSettle();
      expect(api.created, isEmpty);
      expect(atTradePicker('Pick one of the 16 trades'), findsOneWidget);
      expect(find.byType(SnackBar), findsNothing);

      await pickTrade(tester);
      expect(find.text('Pick one of the 16 trades'), findsNothing);
      await tapPost(tester);
      expect(api.created, hasLength(1));
      expect(api.companyRoleKind, 'welder');
      // The trade's own skill, derived from its (untouched) trade form.
      expect(api.companyMatchSkillIds, <String>['mskill_welder']);
      expect(api.companyTradeAnswers, <String, List<String>>{});
    });
  });

  // ---------------------------------------------------------------------------
  // #2635 — company jobs match only within the 16 postable trades. The company
  // form never posts without one of them and never falls back to a free role
  // list, the flat skill picker or free-text skills; its reach preview names
  // the trade so the count scopes as publish will.
  // ---------------------------------------------------------------------------
  group('#2635 — a company job is always one of the 16 trades', () {
    testWidgets(
        'trades that fail to load say why and refuse the post at the trade — '
        'never a free list', (WidgetTester tester) async {
      final _V1SpyApi spy = _V1SpyApi(trades: _companyTrades)
        ..throwOnTradesOnce = const SocketException('offline');
      await pump(tester, PayerRole.company, spy: spy);

      expect(
        atTradePicker(
          'The 16 trades did not load. Check your internet connection and '
          'try again.',
        ),
        findsOneWidget,
      );
      // None of the old fallbacks: a free role list, an optional free trade,
      // the flat skill picker (live on this server) or free-text skills.
      expect(find.text('Role (card illustration)'), findsNothing);
      expect(find.text('Trade (optional)'), findsNothing);
      expect(find.text('Skills this role needs'), findsNothing);
      expect(find.text('CNC operating'), findsNothing);
      expect(find.text('Key skills'), findsNothing);
      expect(find.text('+ Add skill'), findsNothing);

      await typeInto(tester, 'Job title', 'Fitter');
      await fillCardContent(tester);
      await tapPost(tester);
      await tester.pumpAndSettle();
      expect(api.created, isEmpty);
      expect(atTradePicker('Pick one of the 16 trades'), findsOneWidget);

      // Retry brings the 16 back; picking one posts.
      await tester.tap(find.widgetWithText(BbButton, 'Retry'));
      await tester.pumpAndSettle();
      expect(find.textContaining('did not load'), findsNothing);
      await pickTrade(tester);
      await tapPost(tester);
      expect(api.created, hasLength(1));
      expect(api.companyRoleKind, 'welder');
    });

    testWidgets('a catalogue with no trades says so — the post is refused', (
      WidgetTester tester,
    ) async {
      await pump(tester, PayerRole.company, spy: _SpyApi());

      expect(
        atTradePicker(
          'No trades are open for posting right now. Try again in a moment.',
        ),
        findsOneWidget,
      );
      await typeInto(tester, 'Job title', 'Fitter');
      await fillCardContent(tester);
      await tapPost(tester);
      await tester.pumpAndSettle();
      expect(api.created, isEmpty);
      expect(atTradePicker('Pick one of the 16 trades'), findsOneWidget);
    });

    testWidgets("the company reach preview carries the job's trade", (
      WidgetTester tester,
    ) async {
      final _V1SpyApi spy = _V1SpyApi(trades: _companyTrades);
      await pump(tester, PayerRole.company, spy: spy);

      await pickTrade(tester);
      // Past the 350ms debounce.
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();

      expect(spy.reachRoleKinds, isNotEmpty);
      expect(spy.reachRoleKinds.last, 'welder');
      expect(find.text('Reaches 12 workers'), findsOneWidget);
    });

    testWidgets('the agency reach preview stays unscoped (not in #2635)', (
      WidgetTester tester,
    ) async {
      final _V1SpyApi spy = _V1SpyApi();
      await pump(tester, PayerRole.agency, spy: spy);

      await tester.tap(find.text('CNC operating'));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();

      expect(spy.reachRoleKinds, isNotEmpty);
      expect(spy.reachRoleKinds.last, isNull);
    });
  });
}
