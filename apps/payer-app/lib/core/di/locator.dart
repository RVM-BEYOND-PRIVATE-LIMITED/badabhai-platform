import 'package:get_it/get_it.dart';

import '../auth/payer_auth_api.dart';
import '../auth/payer_http.dart';
import '../auth/payer_token_store.dart';
import '../config/app_config.dart';
import '../data/payer_account_api.dart';
import '../data/payer_api_client.dart';
import '../session/app_session_cubit.dart';
import '../session/credits_cubit.dart';

import '../../features/account/presentation/cubit/account_cubit.dart';

import '../../features/home/presentation/cubit/home_cubit.dart';
import '../../features/find/presentation/cubit/find_cubit.dart';
import '../../features/find/presentation/cubit/reveal_cubit.dart';
import '../../features/jobs/presentation/cubit/jobs_cubit.dart';
import '../../features/jobs/presentation/cubit/agency_jobs_cubit.dart';
import '../../features/credits/presentation/cubit/credits_screen_cubit.dart';
import '../../features/earn/presentation/cubit/earn_hub_cubit.dart';
import '../../features/earn/presentation/cubit/referral_cubit.dart';
import '../../features/earn/presentation/cubit/referred_cubit.dart';
import '../../features/earn/presentation/cubit/payouts_cubit.dart';
import '../../features/earn/presentation/cubit/kyc_cubit.dart';
import '../../features/org/presentation/cubit/org_cubit.dart';
import '../../features/capacity/presentation/cubit/capacity_cubit.dart';

/// The composition root. `get_it` wires the dependency graph in exactly one
/// place; screens resolve their cubit through [locator], and cubits receive the
/// single [PayerApiClient] selected by [createPayerApiClient] (the `kUseMocks`
/// seam).
final GetIt locator = GetIt.instance;

/// Registers the whole graph. Idempotent across tests (a second call no-ops once
/// the session is registered). Pass [apiClient] to force a specific client in a
/// widget test without the compile-time `kUseMocks` define.
void setupLocator({
  PayerApiClient? apiClient,
  PayerAuthApi? authApi,
  PayerAccountApi? accountApi,
  SecureKeyValueStore? secureStore,
}) {
  if (locator.isRegistered<AppSessionCubit>()) return;

  // A test that injects a mock [apiClient] wants the WHOLE data+auth+account
  // seam mocked (no real HTTP under `flutter test`), regardless of the
  // compile-time [kUseMocks] default. This keeps every widget/integration test
  // green after P3 flips kUseMocks to false, with no per-test wiring.
  final bool mockSeam = apiClient != null;

  // --- Auth seam (token store + authed HTTP) --------------------------------
  // The token store holds the bearer in secure storage (in-memory fake under
  // tests — the real plugin throws under `flutter test`); PayerHttp signs
  // requests + clears the session on a 401. Both are singletons so the auth API
  // and data client share one bearer.
  locator.registerLazySingleton<PayerTokenStore>(
    () => PayerTokenStore(secureStore ?? FlutterSecureKeyValueStore()),
  );
  locator.registerLazySingleton<PayerHttp>(
    () => PayerHttp(
      baseUrl: kPayerApiBaseUrl,
      tokenStore: locator<PayerTokenStore>(),
      // On a 401 that survives a refresh attempt: wipe the bearer + bounce back
      // to Login. Resolved lazily (closure) so there is no construction cycle.
      onReauth: () => locator<AppSessionCubit>().signOut(),
      // A 401 first tries ONE silent refresh; PayerHttp persists the new bearer
      // + retries. The auth API is resolved lazily (it is itself built over this
      // PayerHttp) so this closure only runs when a refresh is actually needed.
      refreshToken: () => locator<PayerAuthApi>().refresh(),
    ),
  );
  locator.registerLazySingleton<PayerAuthApi>(
    () =>
        authApi ??
        (mockSeam
            ? MockPayerAuthApi()
            : createPayerAuthApi(http: locator<PayerHttp>())),
  );
  // Account (`/payer/me`) seam — MOCK (role-aware canned) vs REAL, behind
  // kUseMocks, mirroring createPayerApiClient. Not on PayerApiClient (that seam
  // carries no `/me`), so binding it is additive.
  locator.registerLazySingleton<PayerAccountApi>(
    () =>
        accountApi ??
        (mockSeam
            ? MockPayerAccountApi(locator<PayerTokenStore>())
            : createPayerAccountApi(
                http: locator<PayerHttp>(),
                tokens: locator<PayerTokenStore>(),
              )),
  );

  // --- Cross-cutting singletons ---------------------------------------------
  // A test-supplied [apiClient] wins; otherwise pick MOCK vs REAL (the REAL
  // client is wired with the shared PayerHttp so it carries the bearer).
  locator.registerLazySingleton<PayerApiClient>(
    () => apiClient ?? createPayerApiClient(http: locator<PayerHttp>()),
  );
  // Session + credit balance are app-wide single instances: the nav, Home, Find,
  // the unlock dialog and Buy-credits all share the same role + balance.
  // signOut() revokes the server session (best-effort) + wipes the bearer from
  // secure storage (guaranteed) via these before clearing to Login.
  locator.registerLazySingleton<AppSessionCubit>(
    () => AppSessionCubit(
      authApi: locator<PayerAuthApi>(),
      accountApi: locator<PayerAccountApi>(),
      tokenStore: locator<PayerTokenStore>(),
    ),
  );
  locator.registerLazySingleton<CreditsCubit>(
    () => CreditsCubit(locator<PayerApiClient>()),
  );

  // --- Per-screen cubits (fresh instance per mount) -------------------------
  locator.registerFactory<HomeCubit>(
    () => HomeCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<FindCubit>(
    // In the mock seam (a test injected the client) force the global MOCK feed
    // so the faceless candidate list renders without a per-job context; in
    // production the feed follows kUseMocks (REAL = per-job applicants).
    () => FindCubit(locator<PayerApiClient>(),
        useRealFeed: mockSeam ? false : null),
  );
  locator.registerFactory<RevealCubit>(
    () => RevealCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<JobsCubit>(
    () => JobsCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<CreditsScreenCubit>(
    () => CreditsScreenCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<AccountCubit>(
    () => AccountCubit(locator<PayerAccountApi>()),
  );

  // --- Agency-only demand (jobs) + Supply / Earn cubits ---------------------
  locator.registerFactory<AgencyJobsCubit>(
    () => AgencyJobsCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<EarnHubCubit>(
    () => EarnHubCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<ReferralCubit>(
    () => ReferralCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<ReferredCubit>(
    () => ReferredCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<PayoutsCubit>(
    () => PayoutsCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<KycCubit>(
    () => KycCubit(locator<PayerApiClient>()),
  );

  // --- Org / team members (ADR-0027) + Hiring capacity (ADR-0016) -----------
  locator.registerFactory<OrgCubit>(
    () => OrgCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<CapacityCubit>(
    () => CapacityCubit(locator<PayerApiClient>()),
  );
}
