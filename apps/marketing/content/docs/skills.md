---
title: Skills
description: Run your own SKILL.md playbooks on any pull request with a cloud agent, from your repository, from Talyn, or from your computer.
---

A skill is a written playbook for an agent: a `SKILL.md` file with instructions for one job, such as a security pass, a review checklist or a changelog entry. Talyn can run a skill on any pull request. An agent checks out the pull request in a sandbox and follows the skill.

A skill file can have `name` and `description` in its frontmatter. The limit is 256 KB.

## Where skills come from

Open **Settings > Skills** to see your skills. There are three kinds:

- **Repo skills**: skills committed to a repository under `.claude/skills/<name>/SKILL.md`. Talyn reads them from the repository's default branch. Select **Re-fetch from GitHub** after you commit a change.
- **Talyn skills**: skills you save in Talyn. They work on every repository in the workspace.
- **Local skills**: skills in `~/.claude/skills` on your computer. The desktop app reads them. Select **Save to Talyn** to make one available everywhere.

## Create a Talyn skill

1. Open **Settings > Skills**.
2. Select **New skill**.
3. Type a name, for example `pr-review`, and a description.
4. Write the instructions in **Content**.
5. Select **Create skill**.

## Run a skill on a pull request

1. On the **Pull requests** or **Review requests** page, hover over the row.
2. Select the wand icon.
3. Pick a skill.

If more than one agent is connected, Talyn asks which one to run it with.

The skill runs as a cloud task on the pull request. A repo skill also tells the agent where the file is in the checkout. You cannot start a skill while another run is working on the same pull request.

## Other places skills run

- As a [code review](/docs/code-review#your-own-reviewers) reviewer.
- As a **Run a skill** action in a [workflow](/docs/workflows).

Each run uses box-hours from your plan.
