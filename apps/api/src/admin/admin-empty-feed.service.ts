import { Inject, Injectable } from "@nestjs/common";
import {
  isFeedPostingsUnionEnabled,
  isMatchV1Enabled,
  type ServerConfig,
} from "@badabhai/config";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import { SERVER_CONFIG } from "../config/config.module";
import { AdminEmptyFeedRepository } from "./admin-empty-feed.repository";
import type {
  AdminEmptyFeedMode,
  AdminEmptyFeedPage,
  AdminEmptyFeedQueryDto,
} from "./admin-empty-feed.dto";

/**
 * #2569 — resolve the ACTIVE feed mode from the same two flags `ApplicationsService.getFeed`
 * reads, then project the empty-feed page.
 *
 * Mode precedence is the feed's, not a local rule: V1 wins when armed; otherwise the interim
 * union; otherwise the legacy `jobs` arm. There is no third, admin-only definition.
 */
@Injectable()
export class AdminEmptyFeedService {
  constructor(
    private readonly repo: AdminEmptyFeedRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async list(query: AdminEmptyFeedQueryDto): Promise<AdminEmptyFeedPage> {
    const mode = AdminEmptyFeedService.feedMode(this.config);
    const result = await this.repo.page({
      mode,
      includeTestAccounts: query.include_test_accounts,
      page: query.page,
      pageSize: query.page_size,
    });

    // `by_trade` groups EVERY worker, including the null-trade bucket, so its sum is the exact
    // total without a fourth full scan.
    const total = result.byTrade.reduce((sum, row) => sum + row.worker_count, 0);

    return {
      workers: result.workers.map((row) => ({
        worker_id: row.worker_id,
        trade_id: row.trade_id,
        trade_name: AdminEmptyFeedService.tradeLabel(row.trade_id),
        city: row.city,
        profile_status: row.profile_status,
        days_since_signup: row.days_since_signup,
      })),
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.ceil(total / query.page_size),
      feed_mode: mode,
      counts: {
        by_trade: result.byTrade.map((row) => ({
          trade_id: row.trade_id,
          trade_name: AdminEmptyFeedService.tradeLabel(row.trade_id),
          count: row.worker_count,
        })),
        by_city: result.byCity.map((row) => ({
          city: row.city,
          count: row.worker_count,
        })),
      },
    };
  }

  /** The feed's own precedence. Kept separate so a unit test can pin all three arms. */
  static feedMode(config: ServerConfig): AdminEmptyFeedMode {
    if (isMatchV1Enabled(config)) return "v1";
    if (isFeedPostingsUnionEnabled(config)) return "union";
    return "jobs";
  }

  /** Canonical label for a trade id; null stays null (no profile ≠ an "unknown" trade). */
  private static tradeLabel(tradeId: string | null): string | null {
    return tradeId === null ? null : labelForTaxonomyId(tradeId);
  }
}
