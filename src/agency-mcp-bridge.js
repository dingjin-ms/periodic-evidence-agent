import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { workerToolDefinitions } from './worker-tool-contract.js';

const endpoint = process.env.PILOT_MCP_ENDPOINT;
const token = process.env.PILOT_MCP_TOKEN;
if (!endpoint || !token) {
  process.stderr.write('Pilot MCP controller endpoint is unavailable.\n');
  process.exitCode = 1;
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => void handleLine(line));
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id, error: { code, message }
  })}\n`);
}

async function handleLine(line) {
  let request;
  try { request = JSON.parse(line); }
  catch {
    fail(null, -32700, 'Invalid JSON');
    return;
  }
  if (request.method === 'notifications/initialized' ||
    request.method === 'notifications/cancelled') return;
  if (request.method === 'ping') {
    reply(request.id, {});
    return;
  }
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: typeof request.params?.protocolVersion === 'string'
        ? request.params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'periodic-evidence-pilot', version: '1.0.0' }
    });
    return;
  }
  if (request.method === 'tools/list') {
    reply(request.id, { tools: workerToolDefinitions.map(tool => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema
    })) });
    return;
  }
  if (request.method !== 'tools/call') {
    fail(request.id ?? null, -32601, 'Method not found');
    return;
  }
  try {
    const response = await controllerCall(request.params?.name, request.params?.arguments ?? {});
    reply(request.id, {
      content: [{
        type: 'text',
        text: typeof response === 'string' ? response : JSON.stringify(response)
      }]
    });
  } catch (error) {
    reply(request.id, {
      isError: true,
      content: [{ type: 'text', text: error.message }]
    });
  }
}

function controllerCall(tool, args) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let output = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Pilot controller timed out.'));
    }, 30000);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.end(`${JSON.stringify({ id: randomUUID(), token, tool, args })}\n`);
    });
    socket.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 1024 * 1024) {
        socket.destroy();
        reject(new Error('Pilot controller response exceeded the protocol limit.'));
      }
    });
    socket.on('error', () => reject(new Error('Pilot controller is unavailable.')));
    socket.on('close', () => {
      clearTimeout(timeout);
      let response;
      try { response = JSON.parse(output.trim()); }
      catch {
        reject(new Error('Pilot controller returned an invalid response.'));
        return;
      }
      if (response.ok) resolve(response.result);
      else reject(new Error(`${response.error?.code ?? 'blocked-protocol'}: ${
        response.error?.message ?? 'Pilot tool failed.'}`));
    });
  });
}
