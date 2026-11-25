---
name: jira-change-safety
description: Rules for changing a live Jira Cloud site safely - a way back for every change, what never to change without a person, and how to report. Use with jira-cloud-admin and jira-automation-rules on every task that changes Jira's configuration.
---

# Changing Jira safely

## Before the first change

- **Say the plan.** List the changes in order, each with the operation and what it touches,
  and which projects share what you change. When the task came from a person, a plan of more
  than a few changes waits for their yes.
- **Prefer a test site.** When the task names one, or the company has one, do it there first
  and say what happened.
- **Keep the way back.** Read and keep, in your notes or the task's comment, the state of each
  thing before you change it: the scheme's grants, the field's contexts, the rule's JSON. A
  change you cannot describe how to undo is not ready.

## Never without a person's explicit yes

- Deleting anything: a project, a field, a scheme, a workflow, a status, a group, a rule. Data
  that hangs on it may go with it, and nobody gets it back.
- Changing the default permission scheme, or any scheme that many projects share.
- Granting or removing **Administer Jira** or **Administer projects**, or changing the members
  of an administrators' group.
- Changing who can browse a project, its issue security levels, or its notification scheme for
  everyone.
- Publishing a workflow scheme draft on a project with live issues.
- Enabling an Automation rule, or a rule whose scope is every project.
- Anything that touches more than one project when the task named one.

When unsure whether something is on this list, it is.

## While changing

- One change per call, each with a `reason` that a person reading the approval understands.
- After each change, read the result back. Stop at the first surprise and report; don't pile
  changes on a state you don't understand.
- Do not retry a failed change in other ways until you know why it failed.

## Report

End with:

1. What changed, one line each, in the order done.
2. How to undo each, with the state you kept.
3. What you did not do, and why, including anything that waits for a person.
