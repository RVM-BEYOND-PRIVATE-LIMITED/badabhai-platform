import 'package:equatable/equatable.dart';

/// A worker's coarse location — city + state only, never finer (matches the
/// `job.city`/`job.state` "coarse bucket" convention already used elsewhere;
/// see packages/db/src/schema/job.ts). Not a street address, never a raw
/// lat/lng surfaced to the UI.
class ResolvedLocation extends Equatable {
  const ResolvedLocation({required this.city, required this.state});

  final String city;
  final String state;

  @override
  List<Object?> get props => <Object?>[city, state];
}

enum LocationLookupFailureReason {
  /// Device location services (GPS/network) are off system-wide.
  serviceDisabled,

  /// The worker declined the permission prompt (or it was denied earlier).
  permissionDenied,

  /// The worker denied permission "forever" — the OS will not prompt again;
  /// only Settings can grant it.
  permissionDeniedForever,

  /// A position was obtained but reverse-geocoding didn't yield a usable
  /// city + state (e.g. mid-ocean coordinates, geocoder returned nothing).
  unresolved,

  /// Anything else (timeout, platform channel error, no geocoder on device).
  unknown,
}

/// Thrown by [LocationLookup.resolveCurrent]. Never crashes the caller —
/// every reason maps to an honest fallback (manual city/state entry).
class LocationLookupFailure implements Exception {
  const LocationLookupFailure(this.reason);

  final LocationLookupFailureReason reason;
}

/// GPS/network location -> city + state, via the device's own geocoder.
/// Deliberately device-only: no backend round-trip, so it works today with
/// no server-side change.
abstract interface class LocationLookup {
  Future<ResolvedLocation> resolveCurrent();
}
