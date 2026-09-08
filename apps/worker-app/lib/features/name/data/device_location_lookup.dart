import 'package:geocoding/geocoding.dart';
import 'package:geolocator/geolocator.dart';

import '../domain/location_lookup.dart';

/// Real [LocationLookup]: geolocator for the GPS/network fix, the device's own
/// OS geocoder (via `geocoding`) to turn coordinates into city + state. No
/// backend round-trip — this resolves entirely on-device.
class DeviceLocationLookup implements LocationLookup {
  DeviceLocationLookup({Geocoding? geocoding})
      : _geocoding = geocoding ?? Geocoding();

  final Geocoding _geocoding;

  /// Silent check — [Geolocator.checkPermission] never shows a system prompt,
  /// so this is safe to call on every app resume. Both halves must hold: the
  /// device's location services on AND the permission already granted.
  @override
  Future<bool> isAvailable() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return false;
      final LocationPermission permission = await Geolocator.checkPermission();
      return permission == LocationPermission.always ||
          permission == LocationPermission.whileInUse;
    } catch (_) {
      // No platform channel (widget-test host), no plugin, no answer — treat
      // an unanswerable question as "not available" and leave manual entry be.
      return false;
    }
  }

  @override
  Future<ResolvedLocation> resolveCurrent() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw const LocationLookupFailure(
          LocationLookupFailureReason.serviceDisabled);
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied) {
      throw const LocationLookupFailure(
          LocationLookupFailureReason.permissionDenied);
    }
    if (permission == LocationPermission.deniedForever) {
      throw const LocationLookupFailure(
          LocationLookupFailureReason.permissionDeniedForever);
    }

    final Position position;
    try {
      position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.medium,
          timeLimit: Duration(seconds: 20),
        ),
      );
    } on LocationServiceDisabledException {
      throw const LocationLookupFailure(
          LocationLookupFailureReason.serviceDisabled);
    } on PermissionDeniedException {
      throw const LocationLookupFailure(
          LocationLookupFailureReason.permissionDenied);
    } catch (_) {
      throw const LocationLookupFailure(LocationLookupFailureReason.unknown);
    }

    final List<Placemark> placemarks;
    try {
      placemarks = await _geocoding.placemarkFromCoordinates(
        position.latitude,
        position.longitude,
      );
    } catch (_) {
      throw const LocationLookupFailure(LocationLookupFailureReason.unknown);
    }
    if (placemarks.isEmpty) {
      throw const LocationLookupFailure(
          LocationLookupFailureReason.unresolved);
    }

    final Placemark p = placemarks.first;
    final String city = _firstNonEmpty(<String?>[
      p.locality,
      p.subAdministrativeArea,
    ]);
    final String state = (p.administrativeArea ?? '').trim();
    if (city.isEmpty || state.isEmpty) {
      throw const LocationLookupFailure(
          LocationLookupFailureReason.unresolved);
    }
    return ResolvedLocation(city: city, state: state);
  }

  String _firstNonEmpty(List<String?> values) {
    for (final String? v in values) {
      final String trimmed = (v ?? '').trim();
      if (trimmed.isNotEmpty) return trimmed;
    }
    return '';
  }
}
