import 'package:flutter/material.dart';

import 'failure.dart';

/// The ACTUAL, worker-facing reason a screen is stuck — for center "stuck"/failed
/// views. An honest cause, never a false "check your internet".
///
/// [NetworkFailure] stays "server se connect nahi ho pa raha" — a refused
/// localhost is indistinguishable from offline at this layer, so we don't blame
/// the worker's connection. Title = WHAT failed (screen owns it); this = WHY.
({IconData icon, String reason}) failureReason(Failure? f) => switch (f) {
      NetworkFailure() => (
          icon: Icons.wifi_off_rounded,
          reason: 'Server se connect nahi ho pa raha. Dobara try karein.',
        ),
      OtpInvalidFailure() => (
          icon: Icons.password_rounded,
          reason: 'OTP sahi nahi. Dobara daalein.',
        ),
      UnauthorizedFailure() => (
          icon: Icons.lock_outline,
          reason: 'Session khatam ho gaya. Dobara login karein.',
        ),
      ConsentRequiredFailure() => (
          icon: Icons.privacy_tip_outlined,
          reason: 'Aage badhne ke liye consent dena hoga.',
        ),
      RateLimitedFailure() => (
          icon: Icons.hourglass_empty_rounded,
          reason: 'Bahut requests. Thodi der baad dobara try karein.',
        ),
      ProfileTimeoutFailure() => (
          icon: Icons.hourglass_top_rounded,
          reason: 'Zyada time lag raha hai. Dobara try karein.',
        ),
      ProfileIncompleteFailure() => (
          icon: Icons.badge_outlined,
          reason: 'Pehle apna profile poora karein.',
        ),
      ResumeNotReadyFailure(:final String message) => (
          icon: Icons.hourglass_top_rounded,
          reason: message,
        ),
      // Voice failures carry step-specific honest copy in [Failure.message]
      // (e.g. "Transcript ready nahi hua…"), which is ALWAYS a client-side
      // constant — never a server body (see mapError) — so it is safe to show.
      VoiceUnavailableFailure(:final String message) => (
          icon: Icons.mic_off_rounded,
          reason: message,
        ),
      // ADR-0032 — photo feature off / unreadable image; client-side constant copy.
      PhotoUnavailableFailure(:final String message) => (
          icon: Icons.no_photography_outlined,
          reason: message,
        ),
      MicPermissionFailure(:final String message) => (
          icon: Icons.mic_off_rounded,
          reason: message,
        ),
      ServerFailure(:final int statusCode) => (
          icon: Icons.error_outline_rounded,
          reason: 'Server error ($statusCode). Thodi der baad try karein.',
        ),
      _ => (
          icon: Icons.error_outline_rounded,
          reason: 'Kuch gadbad ho gayi. Dobara try karein.',
        ),
    };
