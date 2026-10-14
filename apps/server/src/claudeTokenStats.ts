// Shared read-time Claude accounting for Profile Stats and deletion snapshots.
// Old compact modelUsage may be process-cumulative: only versioned results or
// retained per-turn main-loop usage are safe. Never infer a version from dates.
// A versioned result that opened a resumed process is cumulative too; its turn
// counts its main loop instead.
// Rows keep every dispatch origin; callers pick which origins count.
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

// Restricts token CTEs to one thread (delete-time archive) or to the threads a
// subquery returns (time-range recaps), so they skip unrelated history.
export type TokenStatsThreadScope =
  | { readonly threadId: string }
  | { readonly threadIdsQuery: Statement.Fragment };

export function tokenStatsThreadFilter(
  sql: SqlClient.SqlClient,
  column: Statement.Fragment,
  scope: TokenStatsThreadScope | undefined,
): Statement.Fragment {
  if (!scope) {
    return sql.literal("");
  }
  return "threadId" in scope
    ? sql`AND ${column} = ${scope.threadId}`
    : sql`AND ${column} IN (${scope.threadIdsQuery})`;
}

// The scope plus its threads' parents: a subagent's usage is judged against its
// parent's results even when the parent is outside the scope.
function tokenStatsLineageFilter(
  sql: SqlClient.SqlClient,
  column: Statement.Fragment,
  scope: TokenStatsThreadScope | undefined,
): Statement.Fragment {
  if (!scope) {
    return sql.literal("");
  }
  const threads = "threadId" in scope ? sql`SELECT ${scope.threadId}` : scope.threadIdsQuery;
  return sql`AND (${column} IN (${threads}) OR ${column} IN (
    SELECT parent_thread_id FROM projection_threads
    WHERE thread_id IN (${threads}) AND parent_thread_id IS NOT NULL
  ))`;
}

// A non-negative JSON number at `path`, else 0. Paths are constants, never input.
function jsonCount(sql: SqlClient.SqlClient, column: string, path: string): Statement.Fragment {
  return sql.literal(
    `CASE WHEN json_type(${column}, '${path}') IN ('integer', 'real')
      AND json_extract(${column}, '${path}') >= 0
      THEN json_extract(${column}, '${path}') ELSE 0 END`,
  );
}

// Tokens in one modelUsage entry (`entry` holds an object).
function modelUsageTokens(sql: SqlClient.SqlClient, entry: string): Statement.Fragment {
  const count = (field: string) =>
    `CASE WHEN json_type(${entry}, '$.${field}') IN ('integer', 'real')
      AND json_extract(${entry}, '$.${field}') >= 0
      THEN json_extract(${entry}, '$.${field}') ELSE 0 END`;
  return sql.literal(`CASE
    -- Private builds of this PR briefly stored a compact form whose
    -- inputTokens already included cache reads/writes. Its explicit
    -- total is authoritative so those cache subsets are not added twice.
    WHEN json_type(${entry}, '$.totalTokens') IN ('integer', 'real')
      AND json_extract(${entry}, '$.totalTokens') > 0
    THEN json_extract(${entry}, '$.totalTokens')
    -- The SDK modelUsage shape has no totalTokens. Its inputTokens is
    -- uncached input, so all four disjoint counters form the total.
    ELSE ${count("inputTokens")} + ${count("cacheReadInputTokens")}
      + ${count("cacheCreationInputTokens")} + ${count("outputTokens")}
  END`);
}

export function claudeTokenActivityCtes(sql: SqlClient.SqlClient, scope?: TokenStatsThreadScope) {
  const request = (field: string) =>
    jsonCount(sql, "a.payload_json", `$.claudeCache.lastRequest.${field}`);
  return sql`
    claude_completed_source AS (
      SELECT
        a.thread_id,
        a.turn_id,
        a.activity_id,
        a.sequence,
        a.created_at,
        CASE WHEN json_valid(a.payload_json) THEN a.payload_json ELSE '{}' END AS payload_json
      FROM projection_thread_activities a
      WHERE a.kind = 'turn.completed' AND a.turn_id IS NOT NULL
        ${tokenStatsLineageFilter(sql, sql.literal("a.thread_id"), scope)}
    ),
    -- Main-thread API requests, which name the Claude process
    -- (lifecycleGeneration) and native session that served them.
    claude_request_source AS (
      SELECT
        a.thread_id,
        a.turn_id,
        a.created_at,
        json_extract(a.payload_json, '$.claudeCache.lifecycleGeneration') AS generation,
        json_extract(a.payload_json, '$.claudeCache.nativeSessionId') AS native_session_id,
        COALESCE(
          json_extract(a.payload_json, '$.claudeCache.lastRequest.messageId'),
          a.activity_id
        ) AS message_id,
        ${request("inputTokens")} + ${request("cacheCreationInputTokens")} AS fresh_prompt_tokens,
        ${request("cacheReadInputTokens")} AS cache_read_tokens
      FROM projection_thread_activities a
      WHERE a.kind = 'context-window.updated'
        ${tokenStatsLineageFilter(sql, sql.literal("a.thread_id"), scope)}
        AND json_valid(a.payload_json)
        AND json_type(a.payload_json, '$.claudeCache') = 'object'
    ),
    -- Later rows repeat a response's request (output updates, the settled
    -- result), so each response counts once, in the turn that first showed it.
    claude_turn_requests AS (
      SELECT
        thread_id,
        turn_id,
        MIN(generation) AS generation,
        MIN(native_session_id) AS native_session_id,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(fresh_prompt_tokens + cache_read_tokens) AS prompt_tokens
      FROM (
        SELECT r.*,
          ROW_NUMBER() OVER (
            PARTITION BY r.thread_id, r.message_id ORDER BY r.created_at ASC
          ) AS response_rank
        FROM claude_request_source r
      )
      WHERE response_rank = 1 AND turn_id IS NOT NULL
      GROUP BY thread_id, turn_id
    ),
    claude_generation_starts AS (
      SELECT thread_id, native_session_id, generation, MIN(created_at) AS started_at
      FROM claude_request_source
      WHERE generation IS NOT NULL AND native_session_id IS NOT NULL
      GROUP BY thread_id, native_session_id, generation
    ),
    -- Claude Code restores a resumed session's saved usage totals into the
    -- first result of each new process, so that result's modelUsage spans
    -- earlier turns. Results written before Synara withheld it still carry it:
    -- find the first turn of every process that resumed an earlier one.
    claude_generation_turns AS (
      SELECT c.thread_id, c.turn_id, t.generation, t.native_session_id,
        MIN(c.created_at) AS completed_at
      FROM claude_completed_source c
      JOIN claude_turn_requests t ON t.thread_id = c.thread_id AND t.turn_id = c.turn_id
      WHERE t.generation IS NOT NULL AND t.native_session_id IS NOT NULL
      GROUP BY c.thread_id, c.turn_id, t.generation, t.native_session_id
    ),
    claude_resumed_first_turns AS (
      SELECT g.thread_id, g.turn_id
      FROM (
        SELECT thread_id, turn_id, generation, native_session_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id, generation ORDER BY completed_at ASC, turn_id ASC
          ) AS generation_rank
        FROM claude_generation_turns
      ) g
      JOIN claude_generation_starts current_generation
        ON current_generation.thread_id = g.thread_id
       AND current_generation.native_session_id = g.native_session_id
       AND current_generation.generation = g.generation
      WHERE g.generation_rank = 1
        AND EXISTS (
          SELECT 1
          FROM claude_generation_starts earlier
          WHERE earlier.thread_id = current_generation.thread_id
            AND earlier.native_session_id = current_generation.native_session_id
            AND earlier.started_at < current_generation.started_at
        )
    ),
    -- A versioned result's modelUsage covers every request its process made
    -- since the previous result, subagents included. A withheld result (one
    -- that opened a resumed process) or an unusable breakdown still closes
    -- that span, but the parent does not count it.
    claude_settled_results AS (
      SELECT c.thread_id, c.activity_id, c.sequence, c.created_at, t.generation,
        CASE WHEN resumed.turn_id IS NULL
          AND json_type(c.payload_json, '$.modelUsage') = 'object'
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(c.payload_json, '$.modelUsage')) m
            WHERE m.type = 'object' AND ${modelUsageTokens(sql, "m.value")} > 0
          )
          THEN 1 ELSE 0
        END AS trusted
      FROM claude_completed_source c
      LEFT JOIN claude_turn_requests t ON t.thread_id = c.thread_id AND t.turn_id = c.turn_id
      LEFT JOIN claude_resumed_first_turns resumed
        ON resumed.thread_id = c.thread_id AND resumed.turn_id = c.turn_id
      WHERE json_extract(c.payload_json, '$.tokenAccountingVersion') = 1
        AND (json_type(c.payload_json, '$.modelUsage') = 'object' OR resumed.turn_id IS NOT NULL)
    ),
    -- The parent process a subagent ran in: the latest one started before the
    -- subagent's turn ended (a subagent never outlives its process).
    claude_child_turns AS (
      SELECT activity_id, created_at, parent_thread_id, parent_generation
      FROM (
        SELECT child.activity_id, child.created_at, th.parent_thread_id,
          g.generation AS parent_generation,
          ROW_NUMBER() OVER (
            PARTITION BY child.activity_id ORDER BY g.started_at DESC
          ) AS generation_rank
        FROM claude_completed_source child
        JOIN projection_threads th ON th.thread_id = child.thread_id
        LEFT JOIN claude_generation_starts g
          ON g.thread_id = th.parent_thread_id AND g.started_at <= child.created_at
        WHERE th.creation_source = 'provider_native' AND th.parent_thread_id IS NOT NULL
      )
      WHERE generation_rank = 1
    ),
    -- A subagent's requests land in its parent process's next settled result.
    -- That result already counts them unless it was withheld or came from a
    -- later process, which never saw them.
    claude_children_in_parent AS (
      SELECT activity_id
      FROM (
        SELECT child.activity_id, child.parent_generation, settled.generation, settled.trusted,
          ROW_NUMBER() OVER (
            PARTITION BY child.activity_id
            ORDER BY settled.created_at ASC, settled.sequence ASC, settled.activity_id ASC
          ) AS settlement_rank
        FROM claude_child_turns child
        JOIN claude_settled_results settled
          ON settled.thread_id = child.parent_thread_id
         AND settled.created_at >= child.created_at
      )
      WHERE settlement_rank = 1
        AND trusted = 1
        AND (parent_generation IS NULL OR generation IS NULL OR generation = parent_generation)
    ),
    claude_completed_ranked AS (
      SELECT a.thread_id, a.turn_id, a.activity_id, a.created_at, a.payload_json,
        COALESCE(tm.model, CASE WHEN json_valid(th.model_selection_json)
          AND (json_extract(a.payload_json, '$.provider') IS NULL
            OR json_extract(a.payload_json, '$.provider') = json_extract(th.model_selection_json, '$.provider'))
          THEN json_extract(th.model_selection_json, '$.model') END, 'unknown') AS model,
        pm.dispatch_origin,
        ROW_NUMBER() OVER (
          PARTITION BY a.thread_id, a.turn_id
          ORDER BY a.sequence DESC, a.created_at DESC, a.activity_id DESC
        ) AS rank
      FROM claude_completed_source a
      JOIN projection_threads th ON th.thread_id = a.thread_id
      LEFT JOIN turn_model tm ON tm.thread_id = a.thread_id AND tm.turn_id = a.turn_id
      LEFT JOIN projection_turns pt ON pt.thread_id = a.thread_id AND pt.turn_id = a.turn_id
      LEFT JOIN projection_thread_messages pm
        ON pm.thread_id = pt.thread_id AND pm.message_id = pt.pending_message_id
      -- A subagent counts on its own only when no parent result counted it,
      -- e.g. after an interrupted, result-less, or withheld parent result.
      WHERE NOT EXISTS (
          SELECT 1 FROM claude_children_in_parent counted WHERE counted.activity_id = a.activity_id
        )
        ${tokenStatsThreadFilter(sql, sql.literal("a.thread_id"), scope)}
        AND COALESCE(
          json_extract(a.payload_json, '$.provider'), tm.provider,
          CASE WHEN json_valid(th.model_selection_json)
            THEN json_extract(th.model_selection_json, '$.provider') END
        ) = 'claudeAgent'
    ),
    claude_completed AS (
      SELECT c.*,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(payload_json, '$.modelUsage') = 'object'
          AND resumed.turn_id IS NULL
          THEN json_extract(payload_json, '$.modelUsage') END AS models,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(payload_json, '$.mainLoopTokens') IN ('integer', 'real')
          AND json_extract(payload_json, '$.mainLoopTokens') >= 0
          THEN CAST(json_extract(payload_json, '$.mainLoopTokens') AS INTEGER)
          ELSE legacy.tokens
        END AS main_tokens,
        CASE WHEN json_extract(payload_json, '$.tokenAccountingVersion') = 1
          AND json_type(payload_json, '$.mainLoopCacheReadTokens') IN ('integer', 'real')
          AND json_extract(payload_json, '$.mainLoopCacheReadTokens') >= 0
          THEN CAST(json_extract(payload_json, '$.mainLoopCacheReadTokens') AS INTEGER)
        END AS main_cache_read_tokens,
        requests.cache_read_tokens AS request_cache_read_tokens,
        requests.prompt_tokens AS request_prompt_tokens
      FROM claude_completed_ranked c
      LEFT JOIN profile_stats_claude_legacy_usage legacy
        ON legacy.thread_id = c.thread_id AND legacy.turn_id = c.turn_id
      LEFT JOIN claude_resumed_first_turns resumed
        ON resumed.thread_id = c.thread_id AND resumed.turn_id = c.turn_id
      LEFT JOIN claude_turn_requests requests
        ON requests.thread_id = c.thread_id AND requests.turn_id = c.turn_id
      WHERE rank = 1
    ),
    claude_model_usage_entries AS (
      SELECT c.activity_id, c.thread_id, c.turn_id, c.created_at, c.dispatch_origin,
        c.model AS fallback_model,
        m.key AS model,
        CASE WHEN json_valid(m.value) THEN
          CASE WHEN json_type(m.value) = 'object' THEN m.value ELSE '{}' END
        ELSE '{}' END AS usage
      FROM claude_completed c, json_each(c.models) m
    ),
    claude_model_token_candidates AS (
      SELECT activity_id, thread_id, turn_id, created_at, dispatch_origin,
        COALESCE(NULLIF(TRIM(CAST(model AS TEXT)), ''), fallback_model) AS model,
        CAST(${modelUsageTokens(sql, "usage")} AS INTEGER) AS tokens,
        CAST(${jsonCount(sql, "usage", "$.cacheReadInputTokens")} AS INTEGER) AS cache_tokens
      FROM claude_model_usage_entries
    ),
    claude_model_token_rows AS (
      SELECT activity_id, thread_id, turn_id, created_at, dispatch_origin, model, tokens,
        MIN(tokens, cache_tokens) AS cache_tokens
      FROM claude_model_token_candidates
      WHERE tokens > 0
    ),
    -- cache_tokens is the part of tokens read from the prompt cache. A main
    -- loop without a recorded split takes its observed requests' cache share.
    claude_token_rows AS (
      SELECT thread_id, turn_id, created_at, dispatch_origin, model, tokens, cache_tokens
      FROM claude_model_token_rows
      UNION ALL
      SELECT c.thread_id, c.turn_id, c.created_at, c.dispatch_origin, c.model,
        CAST(c.main_tokens AS INTEGER) AS tokens,
        CAST(MIN(c.main_tokens, COALESCE(
          c.main_cache_read_tokens,
          CASE WHEN c.request_prompt_tokens > 0
            THEN ROUND(1.0 * c.main_tokens * c.request_cache_read_tokens / c.request_prompt_tokens)
            ELSE 0
          END
        )) AS INTEGER) AS cache_tokens
      FROM claude_completed c
      WHERE c.main_tokens > 0
        AND NOT EXISTS (
          SELECT 1 FROM claude_model_token_rows m WHERE m.activity_id = c.activity_id
        )
    )
  `;
}
