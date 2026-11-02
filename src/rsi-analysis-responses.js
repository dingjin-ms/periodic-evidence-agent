// Existing host only: no credential discovery, tools, retries or fallback.
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const citations = { type: 'array', items: object({ id: string, sha256: string }) };
export const analysisResponseSchema = object({
  analysisId: string,
  producer: object({ runId: string, occurrence: string, release: string, observationSha256: string }),
  outcome: { type: 'string', enum: ['proposals', 'no-change', 'insufficient-evidence'] },
  rationale: string,
  findings: { type: 'array', items: object({ text: string, citations }) },
  proposals: { type: 'array', items: object({ title: string, benefit: string, uncertainty: string, validation: string, citations }) }
});

// persist must durably retain each record in PRIVATE host storage before resolving.
// A persistence rejection is fatal. Records never include headers/auth configuration.
export const serializeAnalysisRequest = (model, prompt) => JSON.stringify({ model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], tools: [], tool_choice: 'none', store: false, stream: false, text: { format: { type: 'json_schema', name: 'analysis_result', strict: true, schema: analysisResponseSchema } } });

export function createAnalysisResponsesReasoner({ endpoint, model, persist, timeoutMs = 90000, maxInputBytes = Infinity, fetchImpl = fetch }) {
  if (!endpoint || !model || typeof persist !== 'function') throw new Error('Explicit existing host endpoint, model and persistence required');
  return async ({ prompt, tools }) => {
    if (!Array.isArray(tools) || tools.length) throw new Error('Analysis must be tool-free');
    const invocation = { startedAt: new Date().toISOString(), modelRequested: model, modelReturned: null, responseId: null, status: null, httpStatus: null, transport: 'existing host Responses; strict json_schema; tools=[]; no retries' };
    const body = serializeAnalysisRequest(model, prompt);
    if (Buffer.byteLength(body) > maxInputBytes) throw new Error('Analysis input limit exceeded');
    let record = { rawBody: null, text: null, usage: null, invocation };
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs) });
      invocation.httpStatus = response.status;
      record.rawBody = await response.text();
    } catch {
      invocation.completedAt = new Date().toISOString();
      record.failure = 'Network/body-read failure; response or usage unknown; no retry';
      try { await persist({ phase: 'transport-failure', ...record }); }
      catch {
        record.persistence = 'failed';
        const error = new Error('Analysis transport-failure persistence failed; no retry');
        error.analysisResponse = record; throw error;
      }
      const error = new Error(record.failure); error.analysisResponse = record; throw error;
    }
    invocation.completedAt = new Date().toISOString();
    // Save the exact full HTTP body before any JSON parse or protocol validation.
    try {
      await persist({ phase: 'raw-response', ...record });
      let body;
      try { body = JSON.parse(record.rawBody); } catch { throw new Error('Analysis provider body is invalid JSON; no retry'); }
      invocation.modelReturned = body?.model ?? null; invocation.responseId = body?.id ?? null; invocation.status = body?.status ?? null;
      record.usage = body?.usage ?? null;
      record.text = Array.isArray(body?.output) ? body.output.filter(x => x?.type === 'message').flatMap(x => x.content ?? []).filter(x => x?.type === 'output_text').map(x => x.text).join('') : null;
      await persist({ phase: 'decoded-response', ...record });
      if (!response.ok) throw new Error(`Analysis provider HTTP ${response.status}; no retry`);
      if (body?.error || body?.status !== 'completed' || !Array.isArray(body?.output) ||
          body.output.some(x => !['message','reasoning'].includes(x?.type) || (x.type === 'message' && (!Array.isArray(x.content) || x.content.some(c => c?.type !== 'output_text' || typeof c.text !== 'string'))))) throw new Error('Analysis provider incomplete, refusal or tool output; no retry');
      let result;
      try { result = JSON.parse(record.text); } catch { throw new Error('Analysis provider returned invalid JSON; no retry'); }
      return { result, ...record };
    } catch (error) {
      error.analysisResponse = record;
      throw error;
    }
  };
}
