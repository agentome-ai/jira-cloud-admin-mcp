---
name: jira-cloud-admin
description: Administers a Jira Cloud site through the jira-cloud-admin MCP server - projects, issue types, custom fields and their contexts, screens, workflows and workflow schemes, permission and notification schemes, groups. Use for any change to Jira's configuration, and to answer how the site is set up.
---

# Jira Cloud administration

You change a live Jira site that a whole company works in. Each change is live at once, and
nobody gets an undo button. Work in this order, every time:

1. **Check the connection.** Call `jira_admin_status`. It says the site, whose account you act as,
   whether that account is a Jira administrator, and which `change_*` tools you have. Without
   administrator rights most changes fail with `forbidden`: say so, don't work around it.
2. **Find the operation.** `find_admin_operations` with a few words: `custom field context`,
   `workflow scheme draft publish`, `permission grant`. Every operation of Atlassian's
   administration API is there; don't guess endpoints.
3. **Describe it.** `describe_admin_operation` shows its parameters and body. Read it before
   the first call of an operation in a task.
4. **Read the current state** with `read_jira_admin`, and keep what you read: it is the way back
   (see the jira-change-safety skill).
5. **Change** with the tool the operation names, `change_<area>`, and say why in `reason`. The
   person who approves the call reads that sentence.
6. **Read again** and check that the change is what was asked.

## Know the project first

`getProject` (expand nothing) tells you `style`. **Company-managed** projects (`classic`) share
schemes: a change to a scheme reaches every project that uses it. **Team-managed** projects
(`next-gen`) keep their own configuration, which most of these operations don't touch; say so
when asked to change one.

Before changing a shared scheme, find who else uses it: for a workflow scheme,
`getWorkflowSchemeProjectAssociations` with the project ids from `searchProjects`; for a
permission scheme, each project's `getAssignedPermissionScheme`.
If other projects use it and the request is about one project, copy the scheme, change the copy,
and assign it to that project; ask before changing the shared one.

## Recipes

**A new select field on a project's screens**

1. `getFieldsPaginated` with `query` set to the name: make sure it doesn't exist.
2. `createCustomField` (`change_fields`): `name`, `type`
   (`com.atlassian.jira.plugin.system.customfieldtypes:select`) and its `searcherKey`
   (`...:multiselectsearcher` for a select).
3. `getContextsForField`, then `createCustomFieldContext` limited to the project and issue types
   asked for; a global context reaches every project.
4. `createCustomFieldOption` on that context for the options.
5. The project's screens: its issue type screen scheme → screen schemes → screens
   (`getScreens`, `getAllScreenTabs`), then `addScreenTabField` (`change_screens`) on the create
   and edit screens.

**A status or transition in a company-managed workflow**

1. `searchWorkflows` and `readWorkflows` (it reads, though it is a POST) for the workflow and its
   statuses; `search` (statuses) for a status to reuse before `createStatuses`.
2. `validateUpdateWorkflows` with the changed workflow, then `updateWorkflows`. Statuses in use by
   issues need a mapping: the validation says which.

**Which workflow a project uses**

`getAllWorkflowSchemes` and the project's assignment. To change it for live issues, edit a draft:
`createWorkflowSchemeDraftFromParent`, `updateDraftWorkflowMapping`, then
`publishDraftWorkflowScheme`. Publishing answers with a task id: follow it with `getTask` until
it is complete, and report what it says.

**Who may do what in a project**

`getAssignedPermissionScheme` for the project, `getPermissionSchemeGrants` for the scheme.
Grant with `createPermissionGrant` (`change_permissions`), revoke with
`deletePermissionSchemeEntity`. Grant to a project role or group, not to single users, unless
asked.

## Reading large configurations

Lists are paged: pass `startAt` and `maxResults`. A result cut with `[truncated: ...]` means
ask for less: a page, a filter, one item by id. Don't summarize what you didn't read.

## When a call fails

Every failure has a `kind` and a `hint`; follow the hint. `rejected` comes with Jira's own words:
fix the arguments from them and from `describe_admin_operation`. `rate_limited` and
`jira_unavailable` are worth one more try later; the rest are not.
