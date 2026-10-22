import { AzureCliCredential } from '@azure/identity';
import { PilotError, requireThat } from './common.js';

export async function adoAccessToken(config, purpose) {
  const credential = new AzureCliCredential({ tenantId: config.identity.tenantId });
  let token;
  try {
    token = await credential.getToken('499b84ac-1321-427f-aa17-267ca6975798/.default');
  } catch {
    throw new PilotError('blocked-auth', `${purpose} requires designated user sign-in`);
  }
  requireThat(token?.token, `${purpose} returned no token`, 'blocked-auth');
  const claims = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url').toString('utf8'));
  requireThat(claims.oid === config.identity.objectId && claims.tid === config.identity.tenantId,
    `${purpose} identity mismatch`, 'blocked-auth');
  return token.token;
}

export function adoGitEnvironment(token) {
  const environment = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
    GIT_TRACE: '0',
    GIT_TRACE_CURL: '0',
    GIT_TRACE_PACKET: '0'
  };
  // Git enables legacy curl verbosity when this variable exists, even as "0".
  delete environment.GIT_CURL_VERBOSE;
  return environment;
}
