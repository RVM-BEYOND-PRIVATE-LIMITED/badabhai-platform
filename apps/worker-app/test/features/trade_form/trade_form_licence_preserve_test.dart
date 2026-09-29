import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_qualifications_page.dart';

/// #1542 — DATA LOSS. `PUT /workers/me/qualifications` reads a MISSING
/// `licence_number` / `licence_expiry` on a certificate as null and ERASES the
/// stored value, and a certificates save replaces the whole list. The trade
/// form's certificates page ("Koi certificate ya licence hai?") loaded each
/// certificate as name + issuer + year only, so touching ANY certificate there
/// wiped every licence the worker had saved on Profile edit. These pin the
/// round trip: GET → edit on the page → PUT keeps both licence fields.
SessionRepository _session() =>
    SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

/// What `GET /workers/me/qualifications` returns for a worker who saved a
/// licence on Profile edit (the server decrypts it for the worker's own GET).
Map<String, dynamic> _stored() => <String, dynamic>{
  'certificates': <dynamic>[
    <String, dynamic>{
      'name': 'Wireman Licence',
      'issuer': 'Govt. of Haryana',
      'year': 2019,
      'licence_number': 'HR/WL-2019/0042',
      'licence_expiry': '2029-03-31',
    },
    <String, dynamic>{
      'name': 'Fanuc Programming',
      'issuer': 'RVM CAD',
      'year': 2021,
      'licence_number': null,
      'licence_expiry': null,
    },
  ],
  'educations': <dynamic>[],
  'trainings': <dynamic>[],
  'partial': <String>[],
  'dropped_count': 0,
};

/// A repository over a fake server that serves [_stored] and captures the
/// one PUT body.
({TradeFormRepositoryImpl repo, List<Map<String, dynamic>> puts}) _harness() {
  final List<Map<String, dynamic>> puts = <Map<String, dynamic>>[];
  final ApiClient api = ApiClient(
    baseUrl: 'http://test',
    client: MockClient((http.Request req) async {
      expect(req.url.path, '/workers/me/qualifications');
      if (req.method == 'GET') {
        return http.Response(jsonEncode(_stored()), 200);
      }
      expect(req.method, 'PUT');
      puts.add(jsonDecode(req.body) as Map<String, dynamic>);
      return http.Response(
        jsonEncode(<String, dynamic>{
          'worker_id': 'w1',
          'certificate_count': 2,
          'education_count': 0,
        }),
        200,
      );
    }),
  );
  return (repo: TradeFormRepositoryImpl(api, _session()), puts: puts);
}

List<Map<String, dynamic>> _certs(Map<String, dynamic> body) =>
    (body['certificates'] as List<dynamic>).cast<Map<String, dynamic>>();

void main() {
  group('TradeFormCertificateEntry — the licence pair rides along', () {
    test('toJson sends the stored licence unchanged', () {
      const TradeFormCertificateEntry e = TradeFormCertificateEntry(
        name: 'Wireman Licence',
        issuer: 'Govt. of Haryana',
        year: 2019,
        licenceNumber: 'HR/WL-2019/0042',
        licenceExpiry: '2029-03-31',
      );
      expect(e.toJson(), <String, dynamic>{
        'name': 'Wireman Licence',
        'issuer': 'Govt. of Haryana',
        'year': 2019,
        'licence_number': 'HR/WL-2019/0042',
        'licence_expiry': '2029-03-31',
      });
    });

    test('a brand-new certificate sends an explicit null pair', () {
      final Map<String, dynamic> json = const TradeFormCertificateEntry(
        name: 'ITI Certificate',
      ).toJson();
      expect(json.containsKey('licence_number'), isTrue);
      expect(json['licence_number'], isNull);
      expect(json.containsKey('licence_expiry'), isTrue);
      expect(json['licence_expiry'], isNull);
    });

    test(
      'every copyWith edit keeps the licence — the page edits via copyWith',
      () {
        const TradeFormCertificateEntry e = TradeFormCertificateEntry(
          name: 'Wireman Licence',
          licenceNumber: 'HR/WL-2019/0042',
          licenceExpiry: '2029-03-31',
        );
        final TradeFormCertificateEntry edited = e
            .copyWith(name: 'Wireman Licence (Class B)')
            .copyWith(issuer: 'Govt. of Haryana')
            .copyWith(year: 2020)
            .copyWith(issuer: null, year: null);
        expect(edited.licenceNumber, 'HR/WL-2019/0042');
        expect(edited.licenceExpiry, '2029-03-31');
      },
    );
  });

  test('loadSavedQualifications carries each certificate\'s licence', () async {
    final TradeFormQualifications? q = await _harness().repo
        .loadSavedQualifications();

    expect(q!.certificates[0].licenceNumber, 'HR/WL-2019/0042');
    expect(q.certificates[0].licenceExpiry, '2029-03-31');
    expect(q.certificates[1].licenceNumber, isNull);
    expect(q.certificates[1].licenceExpiry, isNull);
    // Prefilling is not touching — nothing would be sent for this list.
    expect(q.certificatesTouched, isFalse);
  });

  test(
    'REGRESSION: edit one certificate, save — no licence is erased',
    () async {
      final ({TradeFormRepositoryImpl repo, List<Map<String, dynamic>> puts})
      h = _harness();
      final TradeFormQualifications loaded = (await h.repo
          .loadSavedQualifications())!;

      // The worker fixes the OTHER certificate's issuer on the trade form — the
      // licensed one is untouched on screen, yet the whole list is re-sent.
      final TradeFormQualifications edited = loaded.copyWith(
        certificates: <TradeFormCertificateEntry>[
          loaded.certificates[0],
          loaded.certificates[1].copyWith(issuer: 'RVM CAD, Pune'),
          const TradeFormCertificateEntry(name: 'Safety Training'),
        ],
        certificatesTouched: true,
      );
      await h.repo.saveQualifications(edited);

      final List<Map<String, dynamic>> sent = _certs(h.puts.single);
      expect(sent[0]['licence_number'], 'HR/WL-2019/0042');
      expect(sent[0]['licence_expiry'], '2029-03-31');
      expect(sent[1]['issuer'], 'RVM CAD, Pune');
      expect(sent[1]['licence_number'], isNull);
      // A brand-new certificate has no licence to keep.
      expect(sent[2]['licence_number'], isNull);
      expect(sent[2]['licence_expiry'], isNull);
    },
  );

  testWidgets('REGRESSION through the page: editing a licensed certificate on '
      '"Koi certificate ya licence hai?" keeps its licence in the save', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final ({TradeFormRepositoryImpl repo, List<Map<String, dynamic>> puts}) h =
        _harness();
    final TradeFormQualifications loaded = (await tester
        .runAsync<TradeFormQualifications?>(h.repo.loadSavedQualifications))!;

    TradeFormQualifications? saved;
    final GlobalKey<TradeFormQualificationsPageState> key =
        GlobalKey<TradeFormQualificationsPageState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: TradeFormQualificationsPage(
              key: key,
              suggestedCertificates: const <String>[],
              enabled: true,
              loadOptions: () async => const QualificationOptionsDto(
                educationCredential: <String, String>{'iti': 'ITI'},
                educationCouncil: <String, String>{'ncvt': 'NCVT'},
              ),
              onSave: (TradeFormQualifications q) => saved = q,
              initialQualifications: loaded,
              onPageChanged: (_, __) {},
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // Edit the LICENSED certificate's name, as a worker fixing a typo would.
    final Finder licensedName = find.byWidgetPredicate(
      (Widget w) => w is TextField && w.controller?.text == 'Wireman Licence',
    );
    expect(licensedName, findsOneWidget);
    await tester.enterText(licensedName, 'Wireman Licence Class B');
    await tester.pump();

    key.currentState!.save();
    expect(saved, isNotNull);
    expect(saved!.certificatesTouched, isTrue);
    expect(saved!.certificates[0].name, 'Wireman Licence Class B');

    await tester.runAsync(() => h.repo.saveQualifications(saved!));
    final List<Map<String, dynamic>> sent = _certs(h.puts.single);
    expect(sent[0]['name'], 'Wireman Licence Class B');
    expect(sent[0]['licence_number'], 'HR/WL-2019/0042');
    expect(sent[0]['licence_expiry'], '2029-03-31');
    expect(sent[1]['name'], 'Fanuc Programming');
  });
}
