import 'package:get_it/get_it.dart';

import '../api/api_client.dart';
import '../config/app_config.dart';
import '../session/session_repository.dart';

import '../../features/auth/data/auth_repository_impl.dart';
import '../../features/auth/domain/auth_repository.dart';
import '../../features/auth/presentation/cubit/otp_verify_cubit.dart';
import '../../features/auth/presentation/cubit/phone_login_cubit.dart';
import '../../features/chat/data/chat_repository_impl.dart';
import '../../features/chat/domain/chat_repository.dart';
import '../../features/chat/presentation/bloc/chat_bloc.dart';
import '../../features/consent/data/consent_repository_impl.dart';
import '../../features/consent/domain/consent_repository.dart';
import '../../features/consent/presentation/cubit/consent_cubit.dart';
import '../../features/profile/data/profile_repository_impl.dart';
import '../../features/profile/domain/profile_repository.dart';
import '../../features/profile/presentation/cubit/profile_cubit.dart';
import '../../features/kit/data/interview_kit_repository_impl.dart';
import '../../features/kit/domain/interview_kit_repository.dart';
import '../../features/kit/presentation/cubit/kit_detail_cubit.dart';
import '../../features/kit/presentation/cubit/kit_list_cubit.dart';
import '../../features/resume/data/resume_edit_repository_impl.dart';
import '../../features/resume/data/resume_repository_impl.dart';
import '../../features/resume/domain/resume_edit_repository.dart';
import '../../features/resume/domain/resume_repository.dart';
import '../../features/resume/presentation/cubit/resume_cubit.dart';
import '../../features/resume/presentation/cubit/resume_edit_cubit.dart';
import '../../features/swipe/data/jobs_repository_impl.dart';
import '../../features/swipe/data/swipe_repository_impl.dart';
import '../../features/swipe/domain/jobs_repository.dart';
import '../../features/swipe/domain/swipe_repository.dart';
import '../../features/swipe/presentation/bloc/swipe_bloc.dart';
import '../../features/swipe/presentation/cubit/job_detail_cubit.dart';

/// The composition root. `get_it` wires the dependency graph in exactly one
/// place; screens resolve their bloc/cubit through [locator], and BLoCs receive
/// their repository, which in turn receives the single [ApiClient] +
/// [SessionRepository].
final GetIt locator = GetIt.instance;

/// Registers the whole graph. Idempotent — calling it again (e.g. across tests)
/// is a no-op, so a test that needs the locator can call it freely.
void setupLocator() {
  if (locator.isRegistered<SessionRepository>()) return;

  // --- Cross-cutting singletons ---------------------------------------------
  // Session first: the ApiClient's rolling-refresh callback closes over it.
  locator.registerLazySingleton<SessionRepository>(() => SessionRepository());

  // ONE ApiClient app-wide: MOCK vs REAL via the createApiClient factory
  // (kUseMocks), with the x-session-token rolling refresh wired to the session.
  locator.registerLazySingleton<ApiClient>(
    () => createApiClient(
      onSessionTokenRefreshed: locator<SessionRepository>().setSessionToken,
    ),
  );

  // --- Repositories (stateless singletons) ----------------------------------
  locator.registerLazySingleton<AuthRepository>(
    () => AuthRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<ConsentRepository>(
    () => ConsentRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<ChatRepository>(
    () => ChatRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<ProfileRepository>(
    () => ProfileRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<ResumeRepository>(
    () => ResumeRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<SwipeRepository>(
    () => SwipeRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<JobsRepository>(
    () => const JobsRepositoryImpl(),
  );
  locator.registerLazySingleton<ResumeEditRepository>(
    () => const ResumeEditRepositoryImpl(),
  );
  locator.registerLazySingleton<InterviewKitRepository>(
    () => const InterviewKitRepositoryImpl(),
  );

  // --- Blocs / Cubits (fresh instance per screen mount) ---------------------
  locator.registerFactory<PhoneLoginCubit>(
    () => PhoneLoginCubit(locator<AuthRepository>()),
  );
  locator.registerFactory<OtpVerifyCubit>(
    () => OtpVerifyCubit(locator<AuthRepository>()),
  );
  locator.registerFactory<ConsentCubit>(
    () => ConsentCubit(locator<ConsentRepository>()),
  );
  locator.registerFactory<ChatBloc>(
    () => ChatBloc(locator<ChatRepository>()),
  );
  locator.registerFactory<ProfileCubit>(
    () => ProfileCubit(locator<ProfileRepository>()),
  );
  locator.registerFactory<ResumeCubit>(
    () => ResumeCubit(locator<ResumeRepository>()),
  );
  locator.registerFactory<SwipeBloc>(
    () => SwipeBloc(locator<SwipeRepository>()),
  );
  locator.registerFactory<JobDetailCubit>(
    () => JobDetailCubit(locator<JobsRepository>(), locator<SwipeRepository>()),
  );
  locator.registerFactory<ResumeEditCubit>(
    () => ResumeEditCubit(locator<ResumeEditRepository>()),
  );
  locator.registerFactory<KitListCubit>(
    () => KitListCubit(locator<InterviewKitRepository>()),
  );
  locator.registerFactory<KitDetailCubit>(
    () => KitDetailCubit(locator<InterviewKitRepository>()),
  );
}
