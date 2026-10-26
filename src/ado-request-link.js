import { requireThat } from './common.js';

export const testRequestRows = [
  ['Starting context', 'Where it starts and what exists; or Standard starting state'],
  ['Input files / data', 'Files or links and key characteristics; or Agent may create synthetic inputs'],
  ['Steps / prompts', 'Ordered actions, prompts, preceding turns and confirmations'],
  ['Expected result', 'Observable outcomes and acceptable variation'],
  ['Constraints / special rules', 'What must not change or happen; or None']
];

export function testRequestLink(policy) {
  for (const key of ['organization', 'project', 'areaPath', 'tag'])
    requireThat(typeof policy[key] === 'string' && policy[key].trim(), `Template URL needs ${key}`);
  const description = '| Field | What to fill in |\n| --- | --- |\n' +
    testRequestRows.map(([label, hint]) => `| ${label} | [${hint}] |`).join('\n');
  const url = new URL(`https://dev.azure.com/${encodeURIComponent(policy.organization)}/${encodeURIComponent(policy.project)}/_workitems/create/Bug`);
  const fields = {
    '[System.Title]': '[Test request] ',
    '[System.AreaPath]': policy.areaPath,
    '[System.Tags]': policy.tag,
    '[System.Description]': description
  };
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  requireThat(url.href.length < 2000, 'Template URL exceeds the supported sharing length');
  return url.href;
}
