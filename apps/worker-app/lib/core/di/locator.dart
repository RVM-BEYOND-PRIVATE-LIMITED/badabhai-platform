import 'package:get_it/get_it.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../auth/auth_api.dart';
import '../auth/auth_factory.dart';
import '../auth/device_id.dart';
import '../auth/locale_store.dart';
import '../auth/reauth_signal.dart';
import '../auth/secure_token_store.dart';
import '../config/app_config.dart';
import '../session/session_repository.dart';

import '../../features/applications/data/applications_repository_impl.dart';
import '../../features/applications/domain/applications_repository.dart';
import '../../features/applications/presentation/cubit/applications_cubit.dart';
import '../../features/auth/domain/auth_session_manager.dart';
import '../../features/auth/presentation/cubit/devices_cubit.dart';
import '../../features/auth/presentation/cubit/enter_pin_cubit.dart';
import '../../features/auth/presentation/cubit/otp_verify_cubit.dart';
import '../../features/auth/presentation/cubit/phone_login_cubit.dart';
import '../../features/auth/presentation/cubit/set_pin_cubit.dart';
import '../../features/chat/data/chat_repository_impl.dart';
import '../../features/chat/domain/chat_repository.dart';
import '../../features/chat/presentation/bloc/chat_bloc.dart';
import '../../features/consent/data/consent_repository_impl.dart';
import '../../features/consent/domain/consent_repository.dart';
import '../../features/consent/presentation/cubit/consent_cubit.dart';
import '../../features/invite/data/invite_repository_impl.dart';
import '../../features/invite/domain/invite_repository.dart';
import '../../features/invite/presentation/cubit/invite_cubit.dart';
import '../../features/settings/presentation/cubit/account_delete_cubit.dart';
import '../../features/voice/data/record_package_voice_recorder.dart';
import '../../features/voice/data/voice_note_repository_impl.dart';
import '../../features/voice/data/voice_pipeline_impl.dart';
import '../../features/voice/domain/voice_note_repository.dart';
import '../../features/voice/domain/voice_pipeline.dart';
import '../../features/voice/domain/voice_recorder.dart';
import '../../features/voice/presentation/cubit/voice_note_cubit.dart';
import '../../features/name/data/name_repository_impl.dart';
import '../../features/name/domain/name_repository.dart';
import '../../features/name/presentation/cubit/name_cubit.dart';
import '../../features/profile/data/profile_repository_impl.dart';
import '../../features/profile/domain/profile_repository.dart';
import '../../features/profile/presentation/cubit/profile_cubit.dart';
import '../../features/profile_tab/data/profile_summary_repository_impl.dart';
import '../../features/profile_tab/domain/profile_summary_repository.dart';
import '../../features/profile_tab/presentation/cubit/profile_tab_cubit.dart';
import '../../features/kit/data/interview_kit_repository_impl.dart';
import '../../features/kit/domain/interview_kit_repository.dart';
import '../../features/kit/presentation/cubit/kit_detail_cubit.dart';
import '../../features/kit/presentation/cubit/kit_list_cubit.dart';
import '../../features/notifications/data/notifications_repository_impl.dart';
import '../../features/notifications/domain/notifications_repository.dart';
import '../../features/notifications/presentation/cubit/notifications_cubit.dart';
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
///
/// [apiClient] is a **test-only** seam: pass a [MockApiClient] to force mock
/// mode for an end-to-end widget test without relying on the compile-time
/// `kUseMocks` dart-define (which is `false` under a plain `flutter test`). In
/// production [main] calls `setupLocator()` with no argument, so the live wiring
/// goes through [createApiClient] exactly as before.
void setupLocator({ApiClient? apiClient, SecureKeyValueStore? secureStore}) {
  // The override only applies to a FRESH graph. Guard against a silent no-op:
  // if the graph is already wired, the early-return below would drop the
  // override and leave the real network client in place (a footgun under
  // `flutter test`). Reset the locator before passing one.
  assert(
    (apiClient == null && secureStore == null) ||
        !locator.isRegistered<SessionRepository>(),
    'setupLocator(apiClient:/secureStore:) was ignored — the locator is already '
    'wired; call `await locator.reset()` before supplying a test override.',
  );
  if (locator.isRegistered<SessionRepository>()) return;

  // --- Cross-cutting singletons ---------------------------------------------
  // Session first: the ApiClient's rolling-refresh callback closes over it.
  locator.registerLazySingleton<SessionRepository>(() => SessionRepository());

  // --- Persistent auth (PASS 1) ---------------------------------------------
  // The plugin-FREE singletons register here (synchronous, no platform call):
  // SecureTokenStore (the secure-storage plugin itself is lazy and only touched
  // on first read/write), DeviceIdProvider, and the ReauthSignal. The two
  // SharedPreferences-backed pieces (LocaleStore + AuthApi) register in the
  // ASYNC [initAuthLocator] below — kept out of the synchronous, plugin-free
  // [setupLocator] so existing widget tests (which never await it) don't trip
  // the SharedPreferences platform channel.
  // The real plugin throws under `flutter test`; an injected in-memory
  // [secureStore] lets the mock-mode e2e exercise persistence without it.
  locator.registerLazySingleton<SecureTokenStore>(
    () => SecureTokenStore(secureStore ?? FlutterSecureKeyValueStore()),
  );
  locator.registerLazySingleton<DeviceIdProvider>(
    () => DeviceIdProvider(locator<SecureTokenStore>()),
  );
  locator.registerLazySingleton<ReauthSignal>(() => ReauthSignal());

  // ONE ApiClient app-wide: MOCK vs REAL via the createApiClient factory
  // (kUseMocks), with the x-session-token rolling refresh wired to the session.
  // A test-supplied [apiClient] override wins (mock-mode e2e).
  locator.registerLazySingleton<ApiClient>(
    () =>
        apiClient ??
        createApiClient(
          onSessionTokenRefreshed: locator<SessionRepository>().setSessionToken,
        ),
  );

  // --- Repositories (stateless singletons) ----------------------------------
  locator.registerLazySingleton<ConsentRepository>(
    () => ConsentRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<NameRepository>(
    () => NameRepositoryImpl(locator<ApiClient>(), locator<SessionRepository>()),
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
    () => InterviewKitRepositoryImpl(locator<ApiClient>()),
  );
  locator.registerLazySingleton<ProfileSummaryRepository>(
    () => ProfileSummaryRepositoryImpl(
        locator<ApiClient>(), locator<SessionRepository>()),
  );
  // Single instance app-wide so the Alerts screen and the nav badge share the
  // same reactive unread count.
  locator.registerLazySingleton<NotificationsRepository>(
    () => NotificationsRepositoryImpl(),
  );
  locator.registerLazySingleton<ApplicationsRepository>(
    () => ApplicationsRepositoryImpl(
        locator<ApiClient>(), locator<SessionRepository>()),
  );
  locator.registerLazySingleton<InviteRepository>(
    () => InviteRepositoryImpl(
        locator<ApiClient>(), locator<SessionRepository>()),
  );

  // --- Voice-note pipeline (A2) ---------------------------------------------
  // The recorder is a DEVICE capability, not backend-dependent — the real
  // `record`-package recorder is wired in BOTH modes (it lazily constructs the
  // plugin, so registering it here never touches a platform channel). Only the
  // two network legs stay MOCK/REAL-split: storage upload (signed-url mint +
  // PUT vs canned path) and transcript resolve (GET /voice/:id vs canned text).
  locator.registerLazySingleton<VoiceRecorder>(
      () => RecordPackageVoiceRecorder());
  locator.registerLazySingleton<VoiceStorageUploader>(
    () => kUseMocks
        ? const MockVoiceStorageUploader()
        : RealVoiceStorageUploader(api: locator<ApiClient>()),
  );
  locator.registerLazySingleton<VoiceTranscriptResolver>(
    () => kUseMocks
        ? const MockVoiceTranscriptResolver()
        : RealVoiceTranscriptResolver(locator<ApiClient>()),
  );
  locator.registerLazySingleton<VoiceNoteRepository>(
    () => VoiceNoteRepositoryImpl(
      recorder: locator<VoiceRecorder>(),
      uploader: locator<VoiceStorageUploader>(),
      resolver: locator<VoiceTranscriptResolver>(),
      api: locator<ApiClient>(),
      chat: locator<ChatRepository>(),
      session: locator<SessionRepository>(),
    ),
  );

  // --- Blocs / Cubits (fresh instance per screen mount) ---------------------
  // Auth cubits resolve [AuthSessionManager] + [LocaleStore] LAZILY (the factory
  // closure runs on demand, after [initAuthLocator] has registered both). The
  // live flows route through the manager, not a repository.
  locator.registerFactory<PhoneLoginCubit>(
    () => PhoneLoginCubit(
      locator<AuthSessionManager>(),
      locale: locator<LocaleStore>().read(),
    ),
  );
  locator.registerFactory<OtpVerifyCubit>(
    () => OtpVerifyCubit(
      locator<AuthSessionManager>(),
      locale: locator<LocaleStore>().read(),
    ),
  );
  locator.registerFactory<SetPinCubit>(
    () => SetPinCubit(
      locator<AuthSessionManager>(),
      locale: locator<LocaleStore>().read(),
    ),
  );
  locator.registerFactory<EnterPinCubit>(
    () => EnterPinCubit(
      locator<AuthSessionManager>(),
      locale: locator<LocaleStore>().read(),
    ),
  );
  locator.registerFactory<DevicesCubit>(
    () => DevicesCubit(
      locator<AuthSessionManager>(),
      locale: locator<LocaleStore>().read(),
    ),
  );
  locator.registerFactory<ConsentCubit>(
    () => ConsentCubit(locator<ConsentRepository>()),
  );
  locator.registerFactory<NameCubit>(
    () => NameCubit(locator<NameRepository>()),
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
  locator.registerFactory<ProfileTabCubit>(
    () => ProfileTabCubit(locator<ProfileSummaryRepository>()),
  );
  locator.registerFactory<NotificationsCubit>(
    () => NotificationsCubit(locator<NotificationsRepository>()),
  );
  locator.registerFactory<ApplicationsCubit>(
    () => ApplicationsCubit(locator<ApplicationsRepository>()),
  );
  locator.registerFactory<InviteCubit>(
    () => InviteCubit(locator<InviteRepository>()),
  );
  locator.registerFactory<VoiceNoteCubit>(
    () => VoiceNoteCubit(locator<VoiceNoteRepository>()),
  );
  // Deps resolved lazily inside the cubit (locator-backed), so a plain factory
  // is enough; tests inject fakes directly.
  locator.registerFactory<AccountDeleteCubit>(
    () => AccountDeleteCubit(),
  );
}

/// Registers the SharedPreferences-backed auth singletons ([LocaleStore] +
/// [AuthApi]) — the part of the auth graph that needs an async platform call.
///
/// Kept OUT of the synchronous, plugin-free [setupLocator] so existing widget
/// tests (which never await it) don't trip the SharedPreferences platform
/// channel. PASS 2's app bootstrap awaits this once before any authed request
/// (e.g. silent login), after [setupLocator]. Idempotent: a second call is a
/// no-op once [AuthApi] is registered.
///
/// In tests, pass an already-built [localeStore] (over an in-memory fake) to
/// avoid the real plugin entirely, and an [authApi] override (e.g. a
/// [MockAuthApi] over a fake secure store) to force the mock auth path for a
/// mock-mode e2e — mirroring the [setupLocator] `apiClient` seam (the
/// compile-time `kUseMocks` is false under a plain `flutter test`).
/// [persistentAuthEnabled] mirrors the [authApi]/[localeStore] test seam: the
/// compile-time [kPersistentAuth] const is false under a plain `flutter test`
/// (no dart-define), so a test that walks the full PIN flow (or the mock-mode
/// e2e) must force it ON the same way the mock api/store are forced.
Future<void> initAuthLocator({
  LocaleStore? localeStore,
  AuthApi? authApi,
  bool persistentAuthEnabled = kPersistentAuth,
}) async {
  if (locator.isRegistered<AuthApi>()) return;

  final LocaleStore store = localeStore ??
      LocaleStore(
        SharedPrefsKeyValueStore(await SharedPreferences.getInstance()),
      );
  locator.registerSingleton<LocaleStore>(store);

  // MOCK vs REAL pick lives in createAuthApi (kUseMocks), mirroring
  // createApiClient. The full signing chain (device id, locale, refresh, reauth)
  // is wired here from the singletons registered in setupLocator. A test-supplied
  // [authApi] override wins (mock-mode e2e).
  locator.registerSingleton<AuthApi>(
    authApi ??
        createAuthApi(
          tokenStore: locator<SecureTokenStore>(),
          deviceId: locator<DeviceIdProvider>(),
          localeStore: locator<LocaleStore>(),
          reauthSignal: locator<ReauthSignal>(),
        ),
  );

  // The orchestration layer (PASS 2): the single source of "am I logged
  // in / locked", listenable by the router. It bridges fresh tokens into the
  // legacy SessionRepository so worker-scoped calls keep their bearer.
  locator.registerSingleton<AuthSessionManager>(
    AuthSessionManager(
      authApi: locator<AuthApi>(),
      tokenStore: locator<SecureTokenStore>(),
      session: locator<SessionRepository>(),
      reauthSignal: locator<ReauthSignal>(),
      persistentAuthEnabled: persistentAuthEnabled,
    ),
  );
}
