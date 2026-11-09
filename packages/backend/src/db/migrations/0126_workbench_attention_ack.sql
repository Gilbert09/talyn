-- workbenches.attention_ack: the sessionAttentionKey the owner saw when they
-- last opened the session. The context rail does not count a session while
-- its current key equals this one, so opening a session clears its badge.
-- A new alert has a new key and counts again.
ALTER TABLE workbenches ADD COLUMN attention_ack text;
