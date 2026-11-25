---
name: jira-automation-rules
description: Creates, changes, enables, disables and removes Jira Cloud Automation rules through the jira-cloud-admin MCP server's change_automation tool and Atlassian's Automation API. Use whenever a task asks for an automation rule, or to find out what rules do on a project.
---

# Jira Cloud Automation rules

Automation rules act on issues by themselves, at any hour, often on many issues at once. A wrong
rule does damage faster than a wrong field. So a new or changed rule starts **disabled**, and is
enabled only once its owner has seen it.

## Find out what exists

- `searchRuleSummaries` (a read, sent as POST) lists rules with their state and scope. Look for a
  rule that already does the job before writing one.
- `getRuleByUuid` gives a rule whole: its trigger, conditions, actions and scope. This is also the
  shape every create and update takes.

## Write a rule

The API takes the rule as JSON in the same shape `getRuleByUuid` returns, and Atlassian documents
little of it. So:

1. Find a rule with the same trigger or action (`searchRuleSummaries`, then `getRuleByUuid`), and
   build on its JSON. Without one, ask the person to make a small rule of that kind in Jira's
   editor, then read it.
2. Leave out the ids of components that don't exist yet: Jira creates new components on create
   and update. Keep the `componentId`s of components that stay.
3. Set its `state` to `DISABLED`.
4. `createRule` (`change_automation`). A UUID you give must be a new UUID v7; leave it out to let
   Jira choose.
5. Read it back with `getRuleByUuid` and check every component.

To start from Atlassian's templates instead: `searchTemplatesWithPost`, then
`createRuleFromTemplate` with the parameters the template asks for.

## Scope

A rule runs for the projects of its scope, given as ARIs:
`ari:cloud:jira:<cloudId>:project/<projectId>`. `jira_admin_status` gives the cloud id;
`getProject` gives the project's numeric id. `updateRuleScope` replaces the whole scope: read it
first and send every project it should keep. A rule for every project is a global rule; make one
only when asked in those words.

## Change, enable, disable, remove

- `updateRule` replaces the rule with the JSON you send: read it, change the part asked for,
  send all of it back.
- `updateRuleState` with `ENABLED` or `DISABLED`. Enable only when the task says to, or after its
  owner approves the disabled rule.
- `deleteDisabledRule` removes a rule that is disabled; disable it first. Prefer disabling: a
  disabled rule keeps its history and can come back.

## Manual rules

`searchManualRulesWithPost` lists rules a person runs by hand on issues. `invokeManualRule` runs
one for the issues you give: it acts at once, on each of them.

## Report

Say which rules you created or changed, their state, their scope, and for a changed rule what it
did before.
