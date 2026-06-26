import 'package:flutter/widgets.dart';

import 'features/splash/presentation/splash_screen.dart';
import 'features/auth/presentation/phone_login_screen.dart';
import 'features/auth/presentation/otp_verify_screen.dart';
import 'features/consent/presentation/consent_screen.dart';
import 'features/chat/presentation/chat_profiling_screen.dart';
import 'features/voice/presentation/voice_note_placeholder_screen.dart';
import 'features/profile/presentation/profile_preview_screen.dart';
import 'features/resume/presentation/resume_preview_screen.dart';
import 'features/swipe/presentation/swipe_jobs_screen.dart';

/// Named routes for the Phase 1 worker-profiling flow.
class Routes {
  static const String splash = '/';
  static const String phoneLogin = '/login';
  static const String otpVerify = '/otp';
  static const String consent = '/consent';
  static const String chatProfiling = '/chat';
  static const String voiceNote = '/voice';
  static const String profilePreview = '/profile';
  static const String resumePreview = '/resume';
  static const String swipeJobs = '/jobs';
}

final Map<String, WidgetBuilder> appRoutes = <String, WidgetBuilder>{
  Routes.splash: (_) => const SplashScreen(),
  Routes.phoneLogin: (_) => const PhoneLoginScreen(),
  Routes.otpVerify: (_) => const OtpVerifyScreen(),
  Routes.consent: (_) => const ConsentScreen(),
  Routes.chatProfiling: (_) => const ChatProfilingScreen(),
  Routes.voiceNote: (_) => const VoiceNotePlaceholderScreen(),
  Routes.profilePreview: (_) => const ProfilePreviewScreen(),
  Routes.resumePreview: (_) => const ResumePreviewScreen(),
  Routes.swipeJobs: (_) => const SwipeJobsScreen(),
};
