import 'package:get_it/get_it.dart';

import '../auth/payer_account_deleted_signal.dart';
import '../auth/payer_auth_api.dart';
import '../auth/payer_http.dart';
import '../auth/payer_token_store.dart';
import '../config/app_config.dart';
import '../data/payer_account_api.dart';
import '../data/payer_api_client.dart';
import '../session/app_session_cubit.dart';
import '../session/credits_cubit.dart';

import '../../features/account/presentation/cubit/account_cubit.dart';

import '../../features/find/presentation/cubit/find_cubit.dart';
import '../../features/find/presentation/cubit/reveal_cubit.dart';
import '../../features/jobs/presentation/cubit/jobs_cubit.dart';
import '../../features/jobs/presentation/cubit/agency_jobs_cubit.dart';
import '../../features/job_posting_chat/data/job_posting_chat_repository_impl.dart';
import '../../features/job_posting_chat/presentation/bloc/job_posting_chat_bloc.dart';
import '../../features/job_posting_chat/presentation/cubit/chat_sessions_cubit.dart';
import '../../features/referral/presentation/cubit/referral_cubit.dart';
import '../../features/agency/presentation/cubit/agency_engagement_cubit.dart';
import '../../features/agency/presentation/cubit/batch_invite_cubit.dart';
import '../../features/agency/presentation/cubit/agency_earnings_cubit.dart';
import '../../features/agency/presentation/cubit/agency_kyc_cubit.dart';
import '../../features/agency/presentation/cubit/agency_payouts_cubit.dart';
import '../../features/credits/presentation/cubit/credits_screen_cubit.dart';
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
///
/// Throws [StateError] in a RELEASE build with no/invalid `API_BASE_URL` — see
/// [resolvePayerApiBaseUrl]. That happens HERE, at startup, so a misbuilt
/// release fails immediately and obviously instead of shipping an app that
/// silently points every request at the debug emulator alias.
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

  // Resolve the base URL EAGERLY (not inside the lazy PayerHttp factory) so a
  // release build missing --dart-define=API_BASE_URL dies at startup rather
  // than on the first network call. Skipped for a MOCK/demo build and the test
  // seam, neither of which makes a real request.
  final String? baseUrl =
      (kUseMocks || mockSeam) ? null : resolvePayerApiBaseUrl();

  // --- Auth seam (token store + authed HTTP) --------------------------------
  // The token store holds the bearer in secure storage (in-memory fake under
  // tests — the real plugin throws under `flutter test`); PayerHttp signs
  // requests + clears the session on a 401. Both are singletons so the auth API
  // and data client share one bearer.
  locator.registerLazySingleton<PayerTokenStore>(
    () => PayerTokenStore(secureStore ?? FlutterSecureKeyValueStore()),
  );
  // App-scoped "this payer's account is gone" signal (410 PAYER_ACCOUNT_DELETED).
  // One instance; PayerHttp fires it, the app root shows ONE dialog + hard-logs-
  // out. Distinct from the 401 refresh path — see [AccountDeletedSignal].
  locator.registerLazySingleton<AccountDeletedSignal>(
    () => AccountDeletedSignal(),
  );
  locator.registerLazySingleton<PayerHttp>(
    () => PayerHttp(
      // Non-null whenever a real request can actually happen; the MOCK/test
      // seams never reach this client, so the debug fallback is inert there.
      baseUrl: baseUrl ?? resolvePayerApiBaseUrl(),
      tokenStore: locator<PayerTokenStore>(),
      // On a 401 that survives a refresh attempt: wipe the bearer + bounce back
      // to Login. Resolved lazily (closure) so there is no construction cycle.
      onReauth: () => locator<AppSessionCubit>().signOut(),
      // On a 410 PAYER_ACCOUNT_DELETED: fire the app-scoped signal so the app
      // root shows ONE non-dismissible dialog and hard-logs-out on OK. Additive
      // and separate from the recoverable 401 path above.
      onAccountDeleted: () => locator<AccountDeletedSignal>().fire(),
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
      // #369 — CreditsCubit is the ONLY app-wide singleton cubit, so it is the
      // only state that survives sign-out. Reset it here or the next payer to
      // sign in on this device sees the previous payer's balance.
      onSessionCleared: () => locator<CreditsCubit>().reset(),
    ),
  );
  locator.registerLazySingleton<CreditsCubit>(
    () => CreditsCubit(locator<PayerApiClient>()),
  );

  // --- Per-screen cubits (fresh instance per mount) -------------------------
  // NOTE: Home no longer has a cubit — it renders the identity header, the
  // shared CreditsCubit balance, and the two real actions. Its old metrics /
  // recent-activity loads had no backend route and were removed.
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

  // --- AI job-posting chat (ADR-0035) ---------------------------------------
  // A FACTORY, and each bloc gets its OWN repository: the repository owns the
  // bound `session_id` for the life of one conversation, so sharing a singleton
  // would leak a finished session's id into the next chat the payer opens.
  locator.registerFactory<JobPostingChatBloc>(
    () => JobPostingChatBloc(
      JobPostingChatRepositoryImpl(locator<PayerApiClient>()),
    ),
  );
  locator.registerFactory<ChatSessionsCubit>(
    () => ChatSessionsCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<AccountCubit>(
    () => AccountCubit(locator<PayerAccountApi>()),
  );

  // --- Agency-only demand (jobs) + supply (referral) ------------------------
  // Referral (link + funnel summary) is one agency-supply surface; the
  // supply-money surfaces (earnings / KYC / payouts) are FLAG-GATED server-side
  // (`AgencyPayoutsEnabledGuard` → neutral 404 while off) and DEGRADE gracefully
  // to a "not available yet" state, so they are safe to wire unconditionally.
  locator.registerFactory<AgencyJobsCubit>(
    () => AgencyJobsCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<ReferralCubit>(
    () => ReferralCubit(locator<PayerApiClient>()),
  );
  // Agency engagement (faceless referred-worker funnel) + batch invite minting —
  // both AGENT-only routes (`/payer/agency/workers`, `/payer/agency/invites/batch`),
  // reached only from the agency Refer-&-earn surface.
  locator.registerFactory<AgencyEngagementCubit>(
    () => AgencyEngagementCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<BatchInviteCubit>(
    () => BatchInviteCubit(locator<PayerApiClient>()),
  );
  // Agency supply-money (earnings · KYC · payouts) — AGENT-only + FLAG-GATED
  // (`/payer/agency/{earnings,kyc,payouts}`), reached from the Refer-&-earn hub.
  // Each cubit maps the neutral 404 to an honest "not available yet" state.
  locator.registerFactory<AgencyEarningsCubit>(
    () => AgencyEarningsCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<AgencyKycCubit>(
    () => AgencyKycCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<AgencyPayoutsCubit>(
    () => AgencyPayoutsCubit(locator<PayerApiClient>()),
  );

  // --- Org / team members (ADR-0027) + Hiring capacity (ADR-0016) -----------
  locator.registerFactory<OrgCubit>(
    () => OrgCubit(locator<PayerApiClient>()),
  );
  locator.registerFactory<CapacityCubit>(
    () => CapacityCubit(locator<PayerApiClient>()),
  );
}
