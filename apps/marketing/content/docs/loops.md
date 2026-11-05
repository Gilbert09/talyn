---
title: Loops
description: Run a prompt on a schedule. Each run starts an agent on your repository, and it opens a pull request when the work needs one.
---

A loop runs a prompt on a schedule: every hour, every weekday morning, once a week. Each run starts an agent on the repository you pick. If the work needs a change, the agent opens a pull request.

Use a loop for routine work, such as updating dependencies, tidying stale feature flags, or writing a weekly summary.

## Create a loop

1. Select **Automations** in the sidebar.
2. Open the **Loops** tab.
3. Select **New loop**.
4. Give it a name.
5. Write the **Prompt**. This is the whole instruction the agent gets. It has the repository checked out and can open a pull request.
6. Set the **Schedule**.
7. Pick the **Repository**. A loop works on one repository.
8. Pick the **Agent** and **Model**.
9. Select **Create loop**.

## Schedule

| Schedule | Runs |
| --- | --- |
| **Hourly** | Every hour, at the minute you pick. |
| **Daily** | Once a day, at the time you pick. This is the default, at 09:00. |
| **Weekdays** | Monday to Friday, at the time you pick. |
| **Weekly** | Once a week, on the day and time you pick. |
| **Custom cron** | A five-field cron expression, for example `0 */4 * * *`. |

Pick a **Timezone** for the schedule. The editor shows the next runs, so you can check it before you save. Daylight saving changes are handled for you.

If Talyn misses a run, for example during an outage, it runs the loop once when it can. It does not replay every run it missed.

## If the last run is still going

Choose what happens when a run is due and the last one has not finished:

- **Skip this run** (the default). The skipped run shows in the history.
- **Start it anyway**.

## Internet access

A loop's sandbox can reach your repository and its agent, and nothing else. This stops a prompt that reads untrusted text, such as a pull request description, from sending your code somewhere.

If the prompt has to call something outside, for example to post to a webhook, choose **Allow the internet**. Turn it on only for prompts you trust.

## MCP servers

A loop's agent gets the tools of your workspace's [MCP servers](/docs/mcp-servers).

- **Whatever the workspace has on** (the default) gives it every server that is on, including servers you connect later.
- **Choose for this loop** gives it only the servers you pick, or none.

## Run now, history and turning off

Select **Run now** to start a run straight away. Expand a loop to see its history. Each run is **Waiting to start**, **Queued**, **Running**, **Succeeded**, **Failed** or **Skipped**, with the reason when it did not run.

Turn a loop off with its switch. Talyn also turns a loop off by itself, and says why, when:

- Its repository or its agent is no longer connected.
- Its schedule has no future runs.
- Five runs in a row failed.

Deleting a loop also removes its history. It does not undo anything the loop already did.

## Cost

Each run starts a Small sandbox and uses box-hours. When you are out of box-hours or every box is busy, the run shows **Waiting for box-hours or credits** or **Waiting for a free box**, and starts when there is room.
