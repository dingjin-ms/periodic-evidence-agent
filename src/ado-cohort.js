import { requireThat } from './common.js';

export const adoResolutionField = 'Microsoft.VSTS.Common.ResolvedReason';
const states = ['Resolved', 'Closed'];
const resolutions = ['Fixed', 'Duplicate'];
export const adoCohortWiql = `[System.State] IN ('${states.join("', '")}') AND [${adoResolutionField}] IN ('${resolutions.join("', '")}')`;

export function isAdoCohort(fields) {
  return states.includes(fields?.['System.State']) && resolutions.includes(fields?.[adoResolutionField]);
}

export function requireAdoCohort(fields) {
  requireThat(states.includes(fields?.['System.State']),
    'ADO regression cohort requires System.State Resolved or Closed', 'blocked-scope');
  requireThat(resolutions.includes(fields?.[adoResolutionField]),
    `ADO regression cohort requires ${adoResolutionField} Fixed or Duplicate; missing or other resolutions are not eligible`,
    'blocked-scope');
}

export function requireAdoEvidenceCohort(record) {
  if (record.source.kind !== 'ado') return;
  requireAdoCohort(record.fields);
  requireThat(record.sourceStatus === record.fields['System.State'],
    'ADO sourceStatus differs from the captured System.State', 'blocked-scope');
}
