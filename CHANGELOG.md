# Changelog

## 0.1.0

First release.

- Every administration operation of the Jira Cloud platform API and the Automation API, read from
  Atlassian's OpenAPI specifications: 468 in 12 areas.
- `jira_admin_status`, `find_admin_operations`, `describe_admin_operation`, `read_jira_admin`,
  and a `change_*` tool per area.
- stdio with credentials from the environment; stateless HTTP with each request's own.
- Three agent skills: `jira-cloud-admin`, `jira-automation-rules`, `jira-change-safety`.
