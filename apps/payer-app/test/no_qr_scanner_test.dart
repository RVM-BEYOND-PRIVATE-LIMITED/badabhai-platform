import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// #608 — RECORDED DECISION, made enforceable.
///
/// The platform GENERATES QR codes (agency posters, the desktop bridge, batch
/// invites) but NEVER SCANS one. The "agent scans worker" loop does not exist,
/// by design: an agent scanning a worker's code or phone screen is a step toward
/// the AGENCY holding worker identity — exactly what ADR-0022 (the faceless
/// boundary) and consent invariant #6 (consent is given by the WORKER, on the
/// WORKER's own device, after they self-onboard) rule out.
///
/// This guard turns that absence into a checked decision rather than an
/// oversight: it fails the instant a camera/QR-scanner package is added, forcing
/// the product call the issue asks for BEFORE any scanner could ship.
void main() {
  test('payer-app declares NO QR-scanner / camera-scan dependency (#608)', () {
    final String pubspec = File('pubspec.yaml').readAsStringSync();
    const List<String> scannerPackages = <String>[
      'mobile_scanner',
      'qr_code_scanner',
      'qr_mobile_vision',
      'ai_barcode',
      'barcode_scan',
      'flutter_barcode_scanner',
      'google_mlkit_barcode_scanning',
    ];
    for (final String pkg in scannerPackages) {
      expect(
        pubspec.contains(pkg),
        isFalse,
        reason: 'A QR SCANNER ("$pkg") crosses the ADR-0022 faceless boundary '
            '(#608): it needs a product call first, not a silent add.',
      );
    }
    // Generation is expected and stays — only SCANNING is ruled out.
    expect(pubspec.contains('qr_flutter'), isTrue,
        reason: 'QR generation is the supported direction');
  });
}
