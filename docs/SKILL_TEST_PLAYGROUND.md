# Skill Test Playground

This file exists only to give cloud-agent skill runs something to chew on.
It is safe to edit, comment on, or delete — nothing imports it.

## What this is for

Talyn can run agent skills (SKILL.md files) against a pull request. This PR
is a harmless target for exercising that flow end-to-end: pick a skill from
the picker on the PR row, run it, and watch the agent post a review or push
a commit here.

## Deliberate nits for review skills to find

The section below contains a few intentional problems, so a PR-review skill
has somthing concrete to flag:

1. The word "somthing" above is mispelled — twice over, in fact.
2. This sentence are grammatically wrong.
3. The heading style in this doc is inconsistant with the rest of /docs.

## Notes

- A skill that pushes fixes should correct the nits and leave the rest alone.
- A skill that only reviews should post a single review comment listing them.
