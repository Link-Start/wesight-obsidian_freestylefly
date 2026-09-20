import type { ProviderProfile } from '../types';
import type { ProviderProjection } from '../runtime/providerProjection';
import { prepareProviderProjection } from '../runtime/providerProjection';

const routingOverrides: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '0',
  CLAUDE_CODE_USE_VERTEX: '0',
  CLAUDE_CODE_USE_FOUNDRY: '0',
  CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '0',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: '',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};

/** Keep local permissions/hooks, override only provider routing and credentials. */
export function managedProjection(profile: ProviderProfile | null, base: NodeJS.ProcessEnv): ProviderProjection {
  if (!profile || !/^http:\/\/127\.0\.0\.1:\d+$/.test(profile.baseUrl) || !profile.apiKey) {
    throw new Error('会员模型本机网关尚未就绪');
  }
  const clean = { ...base };
  for (const key of Object.keys(clean)) {
    if (
      /ANTHROPIC|CLAUDE_CODE_OAUTH|BEDROCK|VERTEX|FOUNDRY|TOKENDANCE|WESIGHT.*(?:TOKEN|SECRET|KEY)|OTEL_|NODE_OPTIONS/i.test(
        key,
      ) ||
      /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET)$/.test(key)
    )
      delete clean[key];
  }
  const projection = prepareProviderProjection('claude', profile, { ...clean, ...routingOverrides });
  projection.env.ANTHROPIC_API_KEY = '';
  // CLI settings take precedence over user/project env settings without removing
  // their permission rules. Only the ephemeral loopback token enters this process.
  const env = Object.fromEntries(
    Object.entries(projection.env).filter(([key]) => key in routingOverrides || key.startsWith('ANTHROPIC_')),
  );
  projection.args.push('--settings', JSON.stringify({ apiKeyHelper: '', env }));
  return projection;
}
