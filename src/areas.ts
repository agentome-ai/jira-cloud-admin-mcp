// The areas of Jira Cloud administration. Each has a change tool of its own, so that a person can
// let an agent edit, say, fields freely while every change to permissions waits for them. Reading
// goes through one tool for all areas.

export type Area = {
  key: string;
  /** What the area covers, as the change tool's description says it. */
  about: string;
  /** Tags of the Jira Cloud platform API in the area; the Automation API is an area of its own. */
  tags: string[];
};

export const AREAS: Area[] = [
  {
    key: 'projects',
    about:
      'projects, their categories, components, versions, roles and role members, properties, features and the schemes a project uses',
    tags: [
      'Projects',
      'Project categories',
      'Project components',
      'Project versions',
      'Project roles',
      'Project role actors',
      'Project properties',
      'Project features',
      'Project email',
      'Project key and name validation',
      'Project templates',
      'Project types',
      'Project permission schemes',
      'Project classification levels',
      'Project avatars',
    ],
  },
  {
    key: 'issue_types',
    about: 'issue types, issue type schemes and issue type screen schemes',
    tags: ['Issue types', 'Issue type schemes', 'Issue type screen schemes', 'Issue type properties'],
  },
  {
    key: 'fields',
    about:
      'custom fields, their contexts and options, field configurations and their schemes, field schemes',
    tags: [
      'Issue fields',
      'Issue custom field contexts',
      'Issue custom field options',
      'Issue custom field associations',
      'Issue field configurations',
      'Field schemes',
    ],
  },
  {
    key: 'screens',
    about: 'screens, their tabs and fields, and screen schemes',
    tags: ['Screens', 'Screen tabs', 'Screen tab fields', 'Screen schemes'],
  },
  {
    key: 'workflows',
    about:
      'workflows, statuses, transitions and their rules, workflow schemes and their drafts, which a change publishes',
    tags: [
      'Workflows',
      'Workflow schemes',
      'Workflow scheme drafts',
      'Workflow scheme project associations',
      'Workflow statuses',
      'Workflow status categories',
      'Status',
      'Workflow transition rules',
    ],
  },
  {
    key: 'permissions',
    about: 'permission schemes and their grants, issue security schemes and levels',
    tags: ['Permission schemes', 'Permissions', 'Issue security schemes', 'Issue security level'],
  },
  {
    key: 'notifications',
    about: 'notification schemes',
    tags: ['Issue notification schemes'],
  },
  {
    key: 'priorities',
    about: 'priorities, priority schemes and resolutions',
    tags: ['Issue priorities', 'Priority schemes', 'Issue resolutions'],
  },
  {
    key: 'people',
    about: 'groups and their members, users and application roles',
    tags: ['Groups', 'Users', 'User search', 'Group and user picker', 'Application roles'],
  },
  {
    key: 'filters',
    about: 'filters, their sharing, and dashboards',
    tags: ['Filters', 'Filter sharing', 'Dashboards'],
  },
  {
    key: 'settings',
    about:
      'Jira settings, the announcement banner, time tracking, issue link types and webhooks, cancelling a long task; also the audit log, JQL checks, issue search and the progress of a long task, which only read',
    tags: [
      'Jira settings',
      'Announcement banner',
      'Time tracking',
      'Issue link types',
      'Webhooks',
      'Audit records',
      'Server info',
      'License metrics',
      'Labels',
      'JQL',
      'Issue search',
      'Myself',
      // Long changes, such as publishing a workflow scheme draft, answer with a task to follow.
      'Tasks',
    ],
  },
  {
    key: 'automation',
    about:
      'Automation rules: create, update, enable, disable, delete a disabled rule, change its scope; rules from templates; run a manual rule',
    tags: [],
  },
];

/** The area of a Jira platform tag, or none when the tag is not administration. */
export function areaOfTag(tag: string): string | undefined {
  return AREAS.find((area) => area.tags.includes(tag))?.key;
}
