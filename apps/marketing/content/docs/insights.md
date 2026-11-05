---
title: Insights
description: See where your box-hours and agent tokens go, what your agents shipped, and how fast sessions start, for each workspace.
---

The **Insights** page shows how a workspace uses Talyn: box time, agent tokens, what got done, and how fast things start. Select **Insights** in the sidebar to open it.

Insights covers one workspace, and only its owner can see it. Days are in UTC.

## Pick a range

Choose **Last 7 days**, **Last 30 days**, **This billing period** or **Custom**. A custom range can be up to 366 days.

## What it shows

**Compute**: box time, the number of box runs started, box-hours per day, and box time split by kind of work and by box size. The footer shows how much of your plan's box-hours this billing period has used.

**Agent usage**: tokens, turns, agent steps (for Claude), tokens per day, and tokens split by kind of work, by agent and by model. **Estimated cost at API prices** shows what the same tokens would cost on the vendor's pay-per-token API. Runs on your subscription are not billed this amount.

**Output**: sessions created, sessions with a pull request, pull requests merged, tasks created and completed, and fix runs.

**Speed**: how long it takes for a box to start, a sleeping box to wake, the agent's first reply, and a turn to start. Each shows the median (p50) and the slowest tenth (p90).

**Top lists**: the ten repositories and the ten sessions that used the most box-hours, and the most tokens.

