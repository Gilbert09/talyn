# Session boot metrics

The first chat in a session stores small `boot_metric` system events. The transcript hides this subtype.
The `box_created` event records the layer, cause, and total start time.
The `wake_start` and `wake_end` events record resumes from the host or storage.
A user message stores `talyn.sentAt` when the route receives it. These times use the backend clock.
The reply time uses the database insert time. Event batching can add a short delay.

Each query uses a read-only transaction. The start queries exclude missing times. The wake query includes successful wakes.

## Box start by layer and cause

```sql
BEGIN READ ONLY;
SELECT e.event ->> 'layer' AS layer,
       e.event ->> 'cause' AS cause,
       count(*) AS starts,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.event ->> 'totalMs')::double precision) AS p50_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY (e.event ->> 'totalMs')::double precision) AS p90_ms
FROM workbench_events e
WHERE e.event ->> 'subtype' = 'boot_metric'
  AND e.event ->> 'metric' = 'box_created'
  AND e.event ->> 'totalMs' IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2;
COMMIT;
```

## Wake by source

```sql
BEGIN READ ONLY;
SELECT e.event ->> 'from' AS source,
       count(*) AS wakes,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.event ->> 'ms')::double precision) AS p50_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY (e.event ->> 'ms')::double precision) AS p90_ms
FROM workbench_events e
WHERE e.event ->> 'subtype' = 'boot_metric'
  AND e.event ->> 'metric' = 'wake_end'
  AND e.event ->> 'ok' = 'true'
  AND e.event ->> 'ms' IS NOT NULL
GROUP BY 1
ORDER BY 1;
COMMIT;
```

## First user message to first agent reply

This query uses the first stored assistant event for the first user message in each session.

```sql
BEGIN READ ONLY;
WITH first_messages AS (
  SELECT DISTINCT ON (c.workbench_id)
         c.workbench_id, e.chat_id, e.turn, e.seq,
         (e.event -> 'talyn' ->> 'sentAt')::timestamptz AS sent_at
  FROM workbench_events e
  JOIN workbench_chats c ON c.id = e.chat_id
  WHERE e.event ->> 'type' = 'user'
    AND e.event -> 'talyn' ->> 'kind' = 'user_message'
    AND e.event -> 'talyn' ->> 'origin' IS DISTINCT FROM 'talyn'
    AND e.event -> 'talyn' ->> 'sentAt' IS NOT NULL
  ORDER BY c.workbench_id, (e.event -> 'talyn' ->> 'sentAt')::timestamptz, e.chat_id, e.seq
), replies AS (
  SELECT m.workbench_id, m.sent_at, min(e.created_at) AS reply_at
  FROM first_messages m
  JOIN workbench_events e ON e.chat_id = m.chat_id AND e.turn = m.turn AND e.seq > m.seq
  WHERE e.event ->> 'type' = 'assistant'
  GROUP BY m.workbench_id, m.sent_at
)
SELECT count(*) AS sessions,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (extract(epoch FROM (reply_at - sent_at)) * 1000)::double precision) AS p50_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY (extract(epoch FROM (reply_at - sent_at)) * 1000)::double precision) AS p90_ms
FROM replies
WHERE reply_at >= sent_at;
COMMIT;
```

## Turn start by agent

`start_ms` measures the wait from the queued message to the agent process start. The turn report writes this value after the turn ends.

```sql
BEGIN READ ONLY;
SELECT c.agent,
       count(*) AS turns,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY t.start_ms::double precision) AS p50_ms,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY t.start_ms::double precision) AS p90_ms
FROM workbench_turn_timings t
JOIN workbench_chats c ON c.id = t.chat_id
WHERE t.start_ms IS NOT NULL
GROUP BY c.agent
ORDER BY c.agent;
COMMIT;
```
