-- MCP servers are available to every repository by default. A JSON null keeps
-- that default and includes repositories added later. A list limits the server
-- to the named repository ids. Stale ids are safe because they match no run.
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "repository_ids" jsonb;
