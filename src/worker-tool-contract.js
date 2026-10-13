export const workerToolDefinitions = Object.freeze([
  {
    name: 'pilot_list',
    description: 'List tracked files in this isolated checkout',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'pilot_search',
    description: 'Search tracked repository text for one bounded literal',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' } },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'pilot_read',
    description: 'Read one bounded repository file, optionally by line range',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'pilot_write',
    description: 'Write one file within approved prefixes; no shell or network',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'pilot_finish',
    description: 'Submit findings and optionally a draft change proposal, never claim validation',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: {
          enum: ['investigated', 'not-reproducible', 'not-actionable', 'propose-change', 'blocked']
        },
        findings: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        skillResult: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { enum: ['succeeded', 'failed', 'needs-input', 'blocked'] },
            classification: { type: 'string' },
            changedFiles: { type: 'array', items: { type: 'string' } },
            testsAddedOrUpdated: { type: 'array', items: { type: 'string' } },
            behaviorCardsAddedOrUpdated: { type: 'array', items: { type: 'string' } },
            unknowns: { type: 'array', items: { type: 'string' } },
            needsHumanDecision: { type: 'boolean' }
          },
          required: [
            'status', 'changedFiles', 'testsAddedOrUpdated',
            'behaviorCardsAddedOrUpdated', 'unknowns', 'needsHumanDecision'
          ]
        }
      },
      required: ['outcome', 'findings'],
      additionalProperties: false
    }
  }
]);

export const workerToolNames = Object.freeze(workerToolDefinitions.map(tool => tool.name));
export const workerToolCliNames =
  Object.freeze(workerToolNames.map(name => `pilot-${name}`));
