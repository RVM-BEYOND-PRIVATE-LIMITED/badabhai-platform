/**
 * The free-chat probe's READS (ADR-0051 §10, #2128) — every query the probe makes, and nothing that
 * writes. Constructed by the CLI on the handle of its ONE read-only transaction; not a Nest
 * provider, because nothing in the running api reads through it.
 *
 * WHAT IT READS, AND WHAT IT DOES NOT. Event rows of the free chat's own names in the window (ids,
 * enums and counts — the payloads carry no text), and — only for a `--sample` — the flushed
 * `chat_messages` line a struggled turn is PROVEN to own. Text is selected only for a proven link;
 * the counts read no text at all.
 *
 * HOW A TURN IS LINKED TO ITS LINE — THE INVARIANT. Every served free-chat turn that is not the
 * greeting writes EXACTLY ONE inbound line flagged `metadata.free_chat` — the worker's message, as an
 * aside (`FreeChatTurns.asideTurn`) — stamped with the turn's clock at request start, which the flush
 * keeps as `created_at`; its `chat.free_chat_turn_served` event is emitted later, after the turn's
 * model calls and CAS. The greeting has no worker line (it opens the session, or answers an
 * identity-intake line, which is flagged `identity_intake` instead). So, for turn E with the session's
 * previous served turn at `prev.at`:
 *
 *   BALANCE  at EVERY served turn P of the session up to and including `prev.at`, the session's
 *            flagged inbound lines stamped at or before P must number exactly its non-greeting served
 *            turns at or before P. Each turn's line is at or before its own event, so balance at P
 *            means no later turn's line was stamped that early AND no earlier turn's line is missing;
 *   ONE      exactly one flagged inbound line lies in `(prev.at, E]`.
 *
 * Under balance, E's own line is not at or before `prev.at` (it would unbalance the count), and it is
 * at or before E — so it is in the span, and with exactly one candidate that candidate IS E's line.
 * Anything else is AMBIGUOUS and links to nothing: overlapping or reordered sends (a later message
 * stamped before an earlier turn's event), a chip no-op (a flagged line with no event), a lost event.
 * Candidates are counted whatever their text, so an empty own line never lets a neighbour's stand in.
 *
 * WHY EVERY TURN, NOT ONLY `prev.at`. Two faults can cancel in a single count: a turn whose line was
 * never flushed (Redis losing its last second of writes, a discarded corrupt buffer, the 600-line cap,
 * a lapsed TTL) leaves the count one short, and a later overlapping send adds one back — balanced at
 * `prev.at`, with a neighbour's line as E's only candidate. Checked at every turn, the first imbalance
 * is seen where it happens, and every later turn of the session is ambiguous.
 *
 * INDEXES. The event reads ride `events_event_name_idx` / `events_occurred_at_idx`; the previous-turn
 * bound and the balance's turns ride `events_subject_idx` (subject_type, subject_id); each line lookup
 * and count is a `chat_messages_session_created_idx` range (session, created_at DESC). The balance is
 * one sort per ref over that session's lines and turns — tens of rows, bounded by the aside cap.
 */
import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { events, type Database } from "@badabhai/db";
import type { EventName } from "@badabhai/event-schema";
import type { FreeChatOutcome, MessageDirection } from "@badabhai/types";
import { FREE_CHAT_METADATA } from "../../chat/chat-transcript.buffer";
import type {
  FreeChatAiTask,
  LinkCounts,
  LinkRef,
  LinkResult,
  ProbeWindow,
  StoredEventRow,
} from "./free-chat-probe";

const INBOUND: MessageDirection = "inbound";
const OUTBOUND: MessageDirection = "outbound";
const TURN_SERVED: EventName = "chat.free_chat_turn_served";
/** The one served outcome with no worker line behind it (see the header). */
const GREETING: FreeChatOutcome = "greeting";
/** The subject every free-chat event is emitted on (`FreeChatService.recordServed`): the session. */
const SESSION_SUBJECT = "chat_session";

/** The per-transaction bounds the probe runs under (`set_config(…, true)` = `SET LOCAL`). */
export interface TransactionBounds {
  /** A slow scan is cancelled rather than left holding production's shared pooler. */
  readonly statementMs: number;
  /** A read that would wait on a lock gives up instead of queueing behind a writer. */
  readonly lockMs: number;
  /** A probe that stalls between statements is ended by the server, releasing its snapshot. */
  readonly idleInTransactionMs: number;
}

export class FreeChatProbeRepository {
  constructor(private readonly db: Database) {}

  /** The server's own word on the transaction: `on` when it is read-only. */
  async transactionReadOnly(): Promise<unknown> {
    const rows = await this.db.execute<{ ro: string }>(
      sql`select current_setting('transaction_read_only') as ro`,
    );
    return (rows as unknown as { ro: string }[])[0]?.ro;
  }

  /** Bound THIS transaction — every setting is local to it and ends with it. */
  async boundTransaction(bounds: TransactionBounds): Promise<void> {
    await this.db.execute(sql`select
      set_config('statement_timeout', ${String(bounds.statementMs)}, true),
      set_config('lock_timeout', ${String(bounds.lockMs)}, true),
      set_config('idle_in_transaction_session_timeout', ${String(bounds.idleInTransactionMs)}, true)`);
  }

  /** The window's rows of one event name — any version; the caller narrows through the registry. */
  async eventsInWindow(name: EventName, window: ProbeWindow): Promise<StoredEventRow[]> {
    return this.readEvents(name, window);
  }

  /** The window's `ai.cost_recorded` rows for the free chat's own AI tasks. */
  async costEventsInWindow(
    window: ProbeWindow,
    tasks: readonly FreeChatAiTask[],
  ): Promise<StoredEventRow[]> {
    return this.readEvents(
      "ai.cost_recorded",
      window,
      inArray(sql`${events.payload}->>'task_type'`, [...tasks]),
    );
  }

  /**
   * Each ref's link, aligned with `refs` (the rule is the header's). For a proven link: the worker's
   * line AS STORED — whether it is blank is decided in JavaScript, by the mask's one blank rule — and
   * the session's last outbound line before it: ANY outbound line, flagged or not, because in résumé
   * mode the line a deflection answers is the interview's own question. Strictly EARLIER: the turn's
   * own reply carries the same `created_at` as the worker's line.
   */
  async linkedLines(refs: readonly LinkRef[]): Promise<LinkResult[]> {
    if (refs.length === 0) return [];
    type Row = {
      k: number;
      n: number;
      balanced: boolean;
      message_id: string | null;
      worker_text: string | null;
      bot_text: string | null;
    };
    const rows = (await this.db.execute<Row>(sql`
      select v.k::int as k, c.n, bal.ok as balanced,
             w.id as message_id, w.body_text as worker_text, b.body_text as bot_text
      from ${refsRelation(refs)}
      ${linkFacts()}
      left join lateral (
        select m.id, m.body_text, m.created_at
        from chat_messages m
        where c.n = 1 and bal.ok and ${candidateLine()}
        limit 1
      ) w on true
      left join lateral (
        select o.body_text
        from chat_messages o
        where o.session_id = v.session_id
          and o.direction = ${OUTBOUND}
          and o.created_at < w.created_at
        order by o.created_at desc, o.id desc
        limit 1
      ) b on true`)) as unknown as Row[];
    const results: LinkResult[] = refs.map(() => ({ kind: "none" }));
    for (const row of rows) {
      results[row.k - 1] =
        row.n === 0
          ? { kind: "none" }
          : row.n > 1 || !row.balanced || row.message_id === null
            ? { kind: "ambiguous" }
            : {
                kind: "linked",
                messageId: row.message_id,
                workerText: row.worker_text ?? "",
                botText: row.bot_text,
              };
    }
    return results;
  }

  /** How many refs link to no line, and how many are ambiguous — the same rule. Selects no text. */
  async linkCounts(refs: readonly LinkRef[]): Promise<LinkCounts> {
    if (refs.length === 0) return { none: 0, ambiguous: 0 };
    const rows = await this.db.execute<{ none: number; ambiguous: number }>(sql`
      select
        count(*) filter (where c.n = 0)::int as none,
        count(*) filter (where c.n > 1 or (c.n = 1 and not bal.ok))::int as ambiguous
      from ${refsRelation(refs)}
      ${linkFacts()}`);
    return (rows as unknown as LinkCounts[])[0] ?? { none: 0, ambiguous: 0 };
  }

  private async readEvents(
    name: EventName,
    window: ProbeWindow,
    extra?: SQL,
  ): Promise<StoredEventRow[]> {
    return this.db
      .select({
        id: events.id,
        occurredAt: events.occurredAt,
        version: events.eventVersion,
        payload: events.payload,
      })
      .from(events)
      .where(
        and(
          eq(events.eventName, name),
          gte(events.occurredAt, window.since),
          lt(events.occurredAt, window.until),
          extra,
        ),
      );
  }
}

/**
 * The refs as a relation `v(session_id, upto_at, k)` — two array parameters whatever the count, `k`
 * the 1-based position (`WITH ORDINALITY`) the results are aligned back on.
 *
 * EVERY ARRAY IS BOUND AS `text[]` AND CAST IN SQL. Drizzle's postgres-js driver installs a
 * pass-through serializer for the timestamp types INCLUDING their array oids (1185 `timestamptz[]`),
 * so an array bound straight as `timestamptz[]` reaches the wire unserialized and the driver throws
 * (measured against Postgres 16). `text[]` is serialized by postgres.js itself; the server casts.
 */
function refsRelation(refs: readonly LinkRef[]): SQL {
  const sessionIds = sql.param(refs.map((r) => r.sessionId));
  const upto = sql.param(refs.map((r) => r.occurredAt.toISOString()));
  return sql`unnest(${sessionIds}::text[]::uuid[], ${upto}::text[]::timestamptz[])
    with ordinality as v(session_id, upto_at, k)`;
}

/**
 * The three facts the link rule reads, per ref `v`:
 *   `prev.at`  the session's previous served turn before `v.upto_at` (ANY time, not only the window);
 *   `c.n`      the candidate lines in `(prev.at, v.upto_at]`, text or not;
 *   `bal.ok`   the session BALANCED at every served turn up to `prev.at` (see the header).
 *
 * `bal.ok` IN ONE PASS. The session's flagged inbound lines (+1 each) and its served turns (−1 each,
 * 0 for a greeting) up to `prev.at` are merged into one timeline; the running sum at a turn is then
 * exactly "lines at or before it minus non-greeting turns at or before it" — RANGE framing puts a line
 * and a turn stamped at the same instant in the same frame, which is the "at or before" of the rule.
 * Balanced means that sum is 0 at every turn. With no previous turn there is nothing to check: true.
 */
function linkFacts(): SQL {
  return sql`
    left join lateral (
      select max(p.occurred_at) as at
      from events p
      where ${sessionTurnEvent()} and p.occurred_at < v.upto_at
    ) prev on true
    left join lateral (
      select count(*)::int as n from chat_messages m where ${candidateLine()}
    ) c on true
    left join lateral (
      select coalesce(bool_and(t.diff = 0) filter (where t.is_turn), true) as ok
      from (
        select x.is_turn,
               sum(x.delta) over (order by x.at range between unbounded preceding and current row) as diff
        from (
          select m.created_at as at, 1 as delta, false as is_turn
          from chat_messages m
          where ${flaggedInboundLine()} and m.created_at <= prev.at
          union all
          select p.occurred_at, case when p.payload->>'outcome' = ${GREETING} then 0 else -1 end, true
          from events p
          where ${sessionTurnEvent()} and p.occurred_at <= prev.at
        ) x
      ) t
    ) bal on true`;
}

/** `p` is one of ref `v`'s session's served-turn events, any version. */
function sessionTurnEvent(): SQL {
  return sql`p.subject_type = ${SESSION_SUBJECT}
    and p.subject_id = v.session_id
    and p.event_name = ${TURN_SERVED}`;
}

/**
 * `m` is one of ref `v`'s session's flagged worker lines: inbound, `metadata.free_chat` (JSONB
 * containment, as every reader of the flag matches it).
 */
function flaggedInboundLine(): SQL {
  return sql`m.session_id = v.session_id
    and m.direction = ${INBOUND}
    and m.metadata @> ${JSON.stringify(FREE_CHAT_METADATA)}::jsonb`;
}

/** `m` is a CANDIDATE line for ref `v`: flagged, after the previous served turn, at or before this one. */
function candidateLine(): SQL {
  return sql`${flaggedInboundLine()}
    and m.created_at > coalesce(prev.at, '-infinity'::timestamptz)
    and m.created_at <= v.upto_at`;
}
