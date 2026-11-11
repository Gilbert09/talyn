---
title: Schedule
description: Run a prompt on a schedule. Each run starts an agent on your repository, and it opens a pull request when the work needs one.
---

A scheduled rule runs a prompt every hour, every weekday morning, or once a week.
Each run starts an agent on the repository you pick. The agent opens a pull request when the work needs one.

Use a scheduled rule for routine work, such as updating dependencies or writing a weekly summary.

## Create a scheduled rule

1. Select **Integrations** in the sidebar.
2. Open **Schedule > Rules**.
3. Select **New loop**.
4. Give it a name.
5. Write the **Prompt**. This is the whole instruction the agent gets. It has the repository checked out and can open a pull request.
6. Choose whether each run starts a **Session** or **Cloud task**. A session stays in Talyn for review and follow-up.
7. Set the **Schedule**.
8. Pick the **Repository**. A scheduled rule works on one repository.
9. Pick the **Agent** and **Model**.
10. Select **Create loop**.

## Schedule

| Schedule | Runs |
| --- | --- |
| **Hourly** | Every hour, at the minute you pick. |
| **Daily** | Once a day, at the time you pick. This is the default, at 09:00. |
| **Weekdays** | Monday to Friday, at the time you pick. |
| **Weekly** | Once a week, on the day and time you pick. |
| **Custom cron** | A five-field cron expression, for example `0 */4 * * *`. |

Pick a **Timezone** for the schedule. The editor shows the next runs, so you can check it before you save. Daylight saving changes are handled for you.

If Talyn misses a run during an outage, it runs the scheduled rule once when it can.
It does not replay every run it missed.

## If the last run is still going

Choose what happens when a run is due and the last one has not finished:

- **Skip this run** (the default). The skipped run shows in the history.
- **Start it anyway**.

## Internet access

A scheduled rule's sandbox can reach your repository and its agent, and nothing else.
This stops untrusted text from sending your code somewhere.

If the prompt has to call something outside, for example to post to a webhook, choose **Allow the internet**. Turn it on only for prompts you trust.

## MCP servers

A scheduled rule's agent gets the tools of your workspace's [MCP servers](/docs/mcp-servers).

- **Whatever the workspace has on** (the default) gives it every server that is on, including servers you connect later.
- **Choose for this rule** gives it only the servers you pick, or none.

## Run now, history and turning off

Select **Run now** to start a run. Open **Schedule > Runs** to see the history.
Each run shows its status and any reason it did not run. A session run includes an **Open session** link.

Turn a scheduled rule off with its switch. Talyn also turns it off and says why when:

- Its repository or its agent is no longer connected.
- Its schedule has no future runs.
- Five runs in a row failed.

Deleting a scheduled rule removes its history. It does not undo work the rule already did.

## Cost

Each run starts a Small sandbox and uses box-hours. When you are out of box-hours or every box is busy, the run shows **Waiting for box-hours or credits** or **Waiting for a free box**, and starts when there is room.
