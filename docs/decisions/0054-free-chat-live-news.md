# ADR-0054: Live news in the profiling-stage free chat (web search, summary + "read more" tiles)

- **Status:** **Accepted — rulings R1–R8 taken by the owner on 2026-10-08** (design session, #2127).
  Backend merges **dark**. The owner arms it on the box after the worker-app release that renders the tiles (R7).
- **Date:** 2026-10-08
- **Owner:** Divyanshu (Backend Platform)
- **Tracking:** #2127 (backend) · app tiles: Rishi's issue, linked from #2127
- **Relates:**
  - [ADR-0051](0051-profiling-stage-free-chat.md): the free chat this extends. Its R12 ("live news: phase 2,
    web search, its own ADR") is this ADR. Its §9 (regional languages) governs the reply language here too.
  - [ADR-0047](0047-lift-pii-restriction.md): the masking policy; G1 and G2 stay enforced.

---

## 1. Context

In the profiling-stage free chat (ADR-0051), a news question ("aaj ka mausam", "Pune mein koi factory khul rahi
hai?", "kal ka match") is classified `casual` or `career`. The reply model then refuses on topic `news`, and the
worker reads the fixed line "Taaza khabar abhi nahi bata sakta. Yeh suvidha jaldi aayegi." The owner wants a real
answer: a short summary of what current news says, with a link to read the full story.

Two provider facts shaped the decision (checked 2026-10-08):
- **Anthropic web search.** It runs server-side on the Claude API at **$10 per 1,000 searches** plus tokens (search
  results count as input tokens), and supports `allowed_domains`, `user_location` and `max_uses`.
  - Citations are always on. Anthropic's terms require showing the source when a search-based answer is shown to an
    end user.
  - It is enabled for an organisation unless an admin disables it in the Console.
- **Gemini grounding with Google Search.** It costs $35 per 1,000 grounded prompts on 2.5 Flash. Google's terms
  require rendering Google's "Search Suggestions" widget and forbid modifying the grounded answer. Both clash with
  this chat: every model line passes our validator, and replies are rewritten into the worker's language.

## 2. Owner rulings (2026-10-08)

| # | Ruling |
|---|---|
| **R1** | **Provider: the Claude web search tool**, on the Anthropic key and Haiku model the free chat already uses. |
| **R2** | **Scope: work AND everyday news.** Work news covers jobs and hiring, factories and companies, wages and minimum wage, skill schemes, ITI admissions and safety rules. Everyday news covers weather, match scores and fuel prices. **An everyday answer steers the worker toward the profile**, said in the prompt (the model ends with one gentle line back to work and the résumé). |
| **R3** | **Off-limits stays off-limits.** Politics, religion, caste, romance, loans and health get the same fixed deflect as today, and distress gets the helpline. Legal, medical or financial advice is refused; news *about* a scheme or rule is not advice. |
| **R4** | **Sources: a trusted list, owner-approved.** It has 41 sites: government, national, Hindi, the five regional languages, and the everyday sources. They are kept in `FREE_CHAT_NEWS_DOMAINS` (`packages/types`). The search may read only these, and a tile may point only at these. |
| **R5** | **Daily cap: 5 news answers per worker per day**, using the IST day. Over the cap the worker gets the NEWS_CAP line. |
| **R6** | **Display: a short text summary, then "read more" tiles** (1–3), each a link to its article. Rendering the tiles is app work (Rishi). |
| **R7** | **Go-live: armed after the app update.** The backend merges dark; the task returns its mock until the owner appends `profiling_free_news` to the box's `AI_REAL_CALL_TASKS`, after the app release that renders the tiles. Older app versions show the summary without tiles. |
| **R8** | **Two new fixed lines** (§5), approved as drafted. Today's NEWS line stays as the answer while news is unarmed. |

## 3. Decision

### 3.1 When news runs

```
free mode → classifier: casual | career → reply model → refuse(topic: news)
  → daily cap reserved?  no  → NEWS_CAP line                      (outcome capped)
  → POST /free-chat/news (Haiku + web_search, ≤2 searches)
      mock (unarmed)             → today's NEWS line ("jaldi aayegi")   (unavailable)
      timeout / error / null     → NEWS_UNAVAILABLE                     (unavailable)
      no_results                 → NEWS_UNAVAILABLE                     (no_results)
      refuse(topic)              → that topic's fixed line              (refused)
      answer → reply gate + tile checks
          fail                   → NEWS_UNAVAILABLE                     (rejected)
          pass                   → lines + 1–3 tiles + résumé chip      (answered)
```

- **The trigger is the reply's existing `news` refusal.** Neither the classifier's categories nor any event enum
  change. The cost is one extra short reply call before the search. Moving news detection into the classifier is a
  candidate for the improvement loop (#2128).
- **Résumé mode never runs news.** Off-topic there is deflected as today (ADR-0051 R6).
- **The cap is reserved before the call and released when the request does not end `answered`.** A failure costs
  the worker nothing. The reservation is memoised outside the CAS loop (the `refs.reply` pattern), so a lost CAS
  never counts twice.

### 3.2 The model call

| Task | Route | Model | Tools | Temp / tokens | API timeout |
|---|---|---|---|---|---|
| `profiling_free_news` | `POST /free-chat/news` | `default_career_model` (Haiku 4.5), **no fallback** (a non-Claude fallback has no web search) | `web_search_20250305`, `max_uses: 2`, `allowed_domains: FREE_CHAT_NEWS_DOMAINS`, `user_location: {country: IN, timezone: Asia/Kolkata}` | 0.3 / 700 | 25 s |

- **Prompt (`FREE_CHAT_NEWS`):**
  - Answer only from the search results; never invent a number, date or name.
  - 1–4 lines of at most 20 words, in the worker's language mixed with English, in Latin letters (ADR-0051 §9).
    The same banned and regional words as the reply prompts apply.
  - Classify `kind` as `work` or `everyday`; an everyday answer ends with one gentle line back to work and the
    résumé (R2).
  - Refuse on the closed topics (R3).
  - Return JSON: `answer` (kind, lines) or `no_results` or `refuse`.
  - Today's date rides in the user message, so "today" and "kal" resolve. The system prompt stays one constant (one
    registry version).
- **Sources are built from the response, not written by the model.** They come from the citations on the answer
  text, falling back to the order of the `web_search_tool_result` URLs. They are deduplicated by URL, at most 3, and
  `site` is the host without `www.`. An answer with no source from a successful search is `no_results`: no
  ungrounded answer is served.
- **Cost.** Each search adds **₹0.83** ($10 / 1,000 at the table's ₹83 / USD) to `estimated_cost_inr`, through
  `build_call_metadata(cost_inr=…)`. The spend ledger's worst-case reservation includes `max_uses` searches and their
  result tokens.
- **The ai-service needs tool support it lacks today.** `providers.complete` and `anthropic_client.acomplete` gain an
  optional `tools` argument (Anthropic only). The parsed result gains the citations and
  `usage.server_tool_use.web_search_requests`.

### 3.3 Validation (the answer is untrusted)

- **Lines** pass the free chat's whole reply gate, `screenFreeChatAnswer` (ADR-0051 §3.4 + §9):
  - shape, Latin-only, persona tokens, promise, sensitive, rating;
  - PII and G1;
  - abuse lexicon, template tokens;
  - the regional walls.

  Any failure means `rejected` and the NEWS_UNAVAILABLE line.
- **Tiles.** Each source must be an `https:` URL of at most 500 characters whose host is a listed domain or one of
  its subdomains. Its title is trimmed of control and format characters, capped at 200 characters, and must carry no
  G1 hard identifier.
  - A failing source is dropped.
  - If no source survives, the answer is `rejected`: an answer is never served without its source.
- The tiles' text is never model-written. Titles and hosts come from the search results.

### 3.4 State, transcript and wire

- **Cap store.** Redis `free_chat:news:{workerId}:{IST yyyy-mm-dd}`: INCR, expiring at the end of the IST day plus
  one hour. It **fails closed**: if the store cannot be read, the request is not made and NEWS_UNAVAILABLE is served
  with `daily_count: null`. This is the `ResumeRateLimit` pattern, with a DECR release.
- **Transcript.**
  - News turns are aside lines (ADR-0051 §3.5), so they never reach extraction or the profile.
  - The bot line carries its tiles as line metadata, so a replay shows them.
  - The flushed row's metadata keeps them too.
- **Wire (additive).**
  - `PostMessageResponse.news_links?: {title, url, site}[]` (1–3), present only on an answered news turn. Absent
    otherwise, never null.
  - The session-messages replay carries the same field on that bot message.
  - Model text keeps `read_aloud: false`.

### 3.5 Events (ids, counts and closed enums only)

- `chat.free_chat_turn_served` v1, **unchanged**. A news turn records `outcome: answered` (tiles served),
  `fixed_line` (cap, unavailable, no_results), `refused` with its topic, or `fallback` (rejected).
- **New `chat.free_chat_news_served` v1:**
  - Fields: worker_id, session_id, `outcome` (answered | no_results | refused | rejected | unavailable | capped),
    `kind` (only for answered), `search_count` (null when capped), `source_count`, `daily_count`, submission_id.
  - Never the question, the answer, a URL or a title.
- `ai.cost_recorded` for `profiling_free_news`, including the search fees.

## 4. Invariants

- **AI never decides.** Code decides when news runs, enforces the cap, validates every line, builds and checks every
  tile, and serves fixed copy for every other outcome.
- **Fail closed.** No real answer, no valid source, a failed line or an unreadable cap all serve a fixed line.
- **Grounded only.** No answer is served without at least one listed source from a search that actually ran.
- **Privacy (ADR-0047).** The worker's own name is redacted before the call (G2), and the masking policy in force
  applies at the ai-service. No worker text, answer, URL or title goes on the event spine. G1 applies to lines and
  titles.
- **ADR-0051 is otherwise unchanged:** categories, the lock, the classifier, fixed lines and the companion.

## 5. Copy (approved 2026-10-08)

| Key | Latin (served) | Devanagari (read aloud) | Chips |
|---|---|---|---|
| NEWS_CAP | Aaj ki khabrein ho gayin. Kal phir poochhiye. Tab tak resume bana lete hain? | आज की ख़बरें हो गईं। कल फिर पूछिए। तब तक रिज़्यूमे बना लेते हैं? | Resume banayein |
| NEWS_UNAVAILABLE | Abhi taaza khabar nahi mil paayi. Thodi der baad phir poochhiye. | अभी ताज़ा ख़बर नहीं मिल पाई। थोड़ी देर बाद फिर पूछिए। | Resume banayein |

ADR-0051's NEWS line stays for the unarmed (mock) answer. Every news turn also carries the "Resume banayein" chip.

## 6. Consequences

- **Cost.** About ₹1.5–2.5 per answered news turn (1–2 searches plus result tokens on Haiku). The cap bounds a worker
  at roughly ₹12 per day.
- **Latency.** A news turn runs the classifier, the short reply refusal and the searched answer: about 8–15 s. The
  app's typing indicator covers it.
- **Known limits (accepted):**
  - The trusted list can miss very local news.
  - Search results are only as current as the sites.
  - Tiles need the app update (R7); older app versions show the summary only.
  - News detection rides the reply's refusal, so a misfiled news question gets a normal reply. #2128's loop measures
    this.

## 7. Rollout and owner actions

1. The contract PR merges: types, ai-contracts, the event, the task name, this ADR.
2. The ai-service and API PRs merge (dark: the task is unarmed, so workers keep today's NEWS line).
3. **Owner:** confirm web search is not disabled in the Anthropic Console (Settings → Capabilities) for the box's
   key.
4. **Rishi:** the app release that renders `news_links` tiles.
5. **Owner:** append `profiling_free_news` to the box's `AI_REAL_CALL_TASKS` and redeploy. News is live.
6. **Rollback:** remove the task from `AI_REAL_CALL_TASKS`, or set `CHAT_FREE_CHAT_DISABLED=true`.

```
Owner rulings R1–R8 taken 2026-10-08 in the design session (sources list and copy approved as drafted).
Signed (Divyanshu): Divyanshu          Date: 2026-10-08
```
