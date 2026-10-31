---
name: talyn-memory
description: Use when you learn a durable fact in this Talyn session, when the person corrects you or says how they want work done, when you make a decision that a later session must know, or when an entry in the Talyn memory index is wrong. Saves short notes to workspace memory, reads an entry before you rely on it, and forgets entries that are wrong.
---

# Workspace memory

Talyn keeps short notes for the workspace. Later sessions get an index of the
notes before each turn: Claude in the rule `talyn-memory.md`, Codex in
`AGENTS.md`. The index shows the name, type, scope and description of each
entry. It does not show the body.

## 1. Decide if a fact is worth saving

Save a fact when a later session would do better work if it knew the fact:

- A durable fact about the work: a service that is flaky, a step that the build needs, a name that the team uses.
- A correction or a preference from the person: "use pnpm", "do not touch the billing module", "keep pull requests small".
- A decision and its reason: "we keep the old API until the mobile app moves, because old app versions still call it".

Do not save:

- What the repository already records: code, comments, README text, configuration.
- What git history records: who changed a file, when, and why the commit says it changed.
- Facts about this turn only: the current error, a temporary branch, a test run.
- Secrets, tokens or personal data.

If you are not sure that a fact is durable, do not save it.

## 2. Pick the scope and the type

Scope:

- `repository` (the default in a session): a fact about this repository.
- `workspace`: a fact that applies to all repositories, for example about the person or the team.

Type:

- `user`: about the person, for example their role or what they know.
- `feedback`: how the person wants the work done.
- `project`: a fact or a decision about the work.
- `reference`: where to find something, for example a dashboard or a document.

## 3. Write the entry

Look at the index first. If an entry about the same subject exists, use its
name again. A write with the same name in the same scope updates that entry.
Do not make a second entry about the same subject.

```
talyn_memory_write
  name: <a short label, at most 64 characters>
  description: <one line, at most 200 characters>
  body: <the note>
  type: <user, feedback, project or reference>
  scope: <repository or workspace>
```

- Keep the name short and specific: "pnpm only", not "package manager notes".
- Write the description so that a session can decide from the index alone if the entry applies.
- Keep the body short. Write the fact, then the reason. Do not copy files or logs.
- Write a date in full, for example 2026-10-31, not "today".

## 4. Read an entry before you rely on it

The index is not the full note. Before an entry changes what you do, read it:

```
talyn_memory_search
  query: <the name from the index>
```

Then read the body with the id from the result:

```
talyn_memory_read
  memory_id: <the id>
```

If the body does not agree with what you see in the repository, the repository
is correct. Tell the person, and update or forget the entry.

## 5. Forget an entry that is wrong

```
talyn_memory_forget
  memory_id: <the id>
```

Forget an entry when it is wrong, out of date, or the person asks. A person can
restore a forgotten entry in Talyn. To change an entry, write it again with the
same name instead.

To see all entries, use `talyn_memory_list`.

## 6. When memory is off

If a memory tool says that memory is off for this workspace, stop using the
memory tools for this session. Do not try again. The person can turn memory on
in Talyn.
