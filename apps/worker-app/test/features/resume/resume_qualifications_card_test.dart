import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show QualificationOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_qualifications.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_card_slots.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_document_view.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_qualifications_card.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';

const QualificationOptionsDto _options = QualificationOptionsDto(
  educationCredential: <String, String>{
    'class_10': '10th pass',
    'class_12': '12th pass',
    'iti': 'ITI',
    'graduate': 'Graduate',
  },
  educationCouncil: <String, String>{
    'state_board': 'State board',
    'ncvt': 'NCVT',
  },
);

/// The worker in `education.jpeg` / `education2.jpeg`, entered in a mixed order.
const TradeFormQualifications _worker = TradeFormQualifications(
  educations: <TradeFormEducationEntry>[
    TradeFormEducationEntry(
      credential: 'class_10',
      council: 'state_board',
      year: 2010,
      institute: 'Govt School',
    ),
    TradeFormEducationEntry(
      credential: 'graduate',
      field: 'Arts',
      council: 'ncvt',
      year: 2016,
      institute: 'Govt Institute',
    ),
    TradeFormEducationEntry(
      credential: 'class_12',
      council: 'state_board',
      year: 2012,
      institute: 'Govt School',
    ),
  ],
  certificates: <TradeFormCertificateEntry>[
    TradeFormCertificateEntry(name: 'Safety training', issuer: 'NSDC', year: 2019),
    TradeFormCertificateEntry(
      name: 'CNC Turning & Fanuc Programming',
      issuer: 'Govt Institute',
      year: 2021,
    ),
  ],
);

class _FakeQualifications implements TradeFormRepository {
  _FakeQualifications(this.saved, {this.options, this.fails = false});

  final TradeFormQualifications? saved;
  final QualificationOptionsDto? options;
  final bool fails;

  @override
  Future<TradeFormQualifications?> loadSavedQualifications() async {
    if (fails) throw Exception('offline');
    return saved;
  }

  @override
  Future<QualificationOptionsDto> loadQualificationOptions() async {
    final QualificationOptionsDto? o = options;
    if (o == null) throw Exception('no vocabulary');
    return o;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('${invocation.memberName}');
}

/// ── `education.jpeg`: education and certificates read as a paragraph ──────
void main() {
  group('the rows, newest first', () {
    test('education is sorted by year, NEWEST FIRST', () {
      final List<ResumeQualificationItem> rows =
          resumeEducationItems(_worker.educations, options: _options);
      expect(rows.map((ResumeQualificationItem r) => r.year),
          <int>[2016, 2012, 2010]);
    });

    test('certificates are sorted by year, NEWEST FIRST', () {
      final List<ResumeQualificationItem> rows =
          resumeCertificateItems(_worker.certificates);
      expect(rows.map((ResumeQualificationItem r) => r.title), <String>[
        'CNC Turning & Fanuc Programming',
        'Safety training',
      ]);
    });

    test('a row with no year goes last; equal years keep the worker order', () {
      final List<ResumeQualificationItem> rows = sortNewestFirst(
        const <ResumeQualificationItem>[
          ResumeQualificationItem(title: 'no year'),
          ResumeQualificationItem(title: 'a', year: 2015),
          ResumeQualificationItem(title: 'b', year: 2015),
          ResumeQualificationItem(title: 'c', year: 2020),
        ],
      );
      expect(rows.map((ResumeQualificationItem r) => r.title),
          <String>['c', 'a', 'b', 'no year']);
    });

    test('readable text: the server vocabulary, else humanised — never a slug',
        () {
      final List<ResumeQualificationItem> withVocab =
          resumeEducationItems(_worker.educations, options: _options);
      expect(withVocab.first.title, 'Graduate — Arts');
      expect(withVocab.first.detail, 'NCVT · Govt Institute');

      final List<ResumeQualificationItem> noVocab =
          resumeEducationItems(_worker.educations);
      for (final ResumeQualificationItem r in noVocab) {
        expect(r.title, isNot(contains('_')), reason: r.title);
        expect(r.detail ?? '', isNot(contains('_')), reason: r.detail);
      }
    });
  });

  group('the old card gives the two rows up', () {
    test('Education + Certificates move; documents and languages stay', () {
      final ({
        List<ResumeExtraSection> sections,
        List<ResumeFact> qualifications,
      }) split = splitQualificationFacts(<ResumeExtraSection>[
        const ResumeExtraSection(
          id: 'qualifications',
          title: 'Qualification, documents & languages',
          chipGroups: <ResumeValueGroup>[
            ResumeValueGroup(label: 'DOCUMENTS', values: <String>['PAN']),
          ],
          facts: <ResumeFact>[
            ResumeFact(label: 'Education', value: '10th pass · 2010'),
            ResumeFact(label: 'Certificates', value: 'CNC (Govt, 2021)'),
            ResumeFact(label: 'Languages spoken', value: 'Hindi · English'),
          ],
        ),
      ]);

      expect(split.qualifications.map((ResumeFact f) => f.label),
          <String>['Education', 'Certificates']);
      expect(split.sections.single.facts.map((ResumeFact f) => f.label),
          <String>['Languages spoken']);
      expect(split.sections.single.chipGroups, hasLength(1));
    });

    test('a section left with nothing is dropped, not drawn empty', () {
      final ({
        List<ResumeExtraSection> sections,
        List<ResumeFact> qualifications,
      }) split = splitQualificationFacts(const <ResumeExtraSection>[
        ResumeExtraSection(
          id: 'qualifications',
          title: 'Qualification',
          facts: <ResumeFact>[ResumeFact(label: 'Education', value: 'ITI')],
        ),
      ]);
      expect(split.sections, isEmpty);
      expect(split.qualifications, hasLength(1));
    });
  });

  group('the card on screen', () {
    const List<ResumeFact> fallback = <ResumeFact>[
      ResumeFact(label: 'Education', value: '10th pass · State board · 2010'),
    ];

    Future<void> pump(WidgetTester tester, TradeFormRepository? repo) async {
      await locator.reset();
      if (repo != null) locator.registerSingleton<TradeFormRepository>(repo);
      addTearDown(locator.reset);
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: ResumeQualificationsCard(fallback: fallback),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('its own titled card, one row per entry, newest first',
        (WidgetTester tester) async {
      await pump(tester, _FakeQualifications(_worker, options: _options));

      expect(find.text(kResumeQualificationsTitle), findsOneWidget);
      expect(find.text(kResumeEducationLabel), findsOneWidget);
      expect(find.text(kResumeCertificatesLabel), findsOneWidget);
      expect(find.text('Graduate — Arts', findRichText: true), findsOneWidget);
      expect(find.text('NCVT · Govt Institute'), findsOneWidget);
      expect(find.text('2021'), findsOneWidget);

      // Newest education above the older ones.
      final double grad =
          tester.getTopLeft(find.text('Graduate — Arts', findRichText: true)).dy;
      final double twelfth =
          tester.getTopLeft(find.text('12th pass', findRichText: true)).dy;
      final double tenth =
          tester.getTopLeft(find.text('10th pass', findRichText: true)).dy;
      expect(grad, lessThan(twelfth));
      expect(twelfth, lessThan(tenth));

      // The paragraph is gone.
      expect(find.text('10th pass · State board · 2010'), findsNothing);
    });

    testWidgets('no structured rows: the sheet line stays, under its label',
        (WidgetTester tester) async {
      await pump(
        tester,
        _FakeQualifications(const TradeFormQualifications()),
      );
      expect(find.text(kResumeQualificationsTitle), findsOneWidget);
      expect(find.text('EDUCATION'), findsOneWidget);
      expect(find.text('10th pass · State board · 2010'), findsOneWidget);
    });

    testWidgets('a failed read keeps the sheet line — never an empty card',
        (WidgetTester tester) async {
      await pump(tester, _FakeQualifications(null, fails: true));
      expect(find.text('10th pass · State board · 2010'), findsOneWidget);
    });
  });
}
