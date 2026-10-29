export const workerToolDefinitions = Object.freeze([
  {
    name: 'pilot_list',
    description: 'List tracked files, optionally below one repository-relative directory',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: [],
      additionalProperties: false
    }
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
    description: 'Read one bounded repository file or an exact skill-bundle: manifest path, optionally by line range',
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
    name: 'pilot_replace_lines',
    description: 'Surgically replace at most 500 existing lines within approved edit bounds; expected text must match',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        expected: { type: 'string' },
        replacement: { type: 'string' }
      },
      required: ['path', 'startLine', 'endLine', 'expected', 'replacement'],
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
            coverageReview: {
              type: 'array', minItems: 1, maxItems: 50,
              description: 'Author-reported seam inventory, not an independent quality grade.',
              items: {
                type: 'object', additionalProperties: false,
                required: ['seam', 'evidenceBasis', 'unitEvidence', 'integrationEvidence',
                  'testFiles', 'defectDetected', 'residuals'],
                properties: {
                  seam: { type: 'string', minLength: 1 },
                  evidenceBasis: { type: 'string', minLength: 1 },
                  unitEvidence: { type: 'array', items: { type: 'string' } },
                  integrationEvidence: { type: 'array', items: { type: 'string' } },
                  testFiles: { type: 'array', uniqueItems: true, items: { type: 'string' } },
                  defectDetected: { type: 'string', minLength: 1 },
                  residuals: { type: 'array', items: { type: 'string' } }
                }
              }
            },
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
