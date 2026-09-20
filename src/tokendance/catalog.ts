export const TOKEN_DANCE = {
  name: 'TokenDance',
  origin: 'https://tokendance.space',
  baseUrl: 'https://tokendance.space/gateway',
  catalogUrl: 'https://tokendance.space/gateway/v1/models',
  authUrl: 'https://tokendance.space/auth',
  exchangeUrl: 'https://tokendance.space/portal/api/v1/auth/keys',
  secretId: 'wesight-tokendance-oauth-key',
  credentialRef: 'wesight-credential:tokendance',
  messages: 'anthropic:messages',
  chat: 'openai:chat-completions',
} as const;

export const TOKEN_DANCE_MODEL_IDS = [
  'deepseek-v4.1-flash', 'glm-5.3-flash', 'glm-5.3',
  'deepseek-v4-pro-0813', 'kimi-k3', 'hy4-preview',
] as const;

export interface TokenDanceModel {
  id: string;
  name: string;
  supportedProtocols: string[];
}

/** Display-only snapshot; execution always validates the live catalog first. */
export const TOKEN_DANCE_MODELS: TokenDanceModel[] = TOKEN_DANCE_MODEL_IDS.map((id, index) => ({
  id,
  name: ['DeepSeek V4.1 Flash', 'GLM 5.3 Flash', 'GLM 5.3', 'DeepSeek V4 Pro 0813', 'Kimi K3', 'Hy4 Preview'][index],
  supportedProtocols: index < 4 ? [TOKEN_DANCE.messages, TOKEN_DANCE.chat] : [TOKEN_DANCE.chat],
}));

export function parseTokenDanceCatalog(payload: unknown): TokenDanceModel[] {
  if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('TokenDance 模型目录格式无效，请刷新重试。');
  }
  const rows: unknown[] = payload.data;
  return TOKEN_DANCE_MODELS.flatMap(preset => {
    const row = rows.find((value): value is Record<string, unknown> => Boolean(value)
      && typeof value === 'object' && 'id' in value! && value.id === preset.id);
    if (!row || !Array.isArray(row.supported_protocols)) return [];
    const supportedProtocols = row.supported_protocols.filter((value): value is string => typeof value === 'string');
    if (!supportedProtocols.includes(TOKEN_DANCE.messages) && !supportedProtocols.includes(TOKEN_DANCE.chat)) return [];
    return [{ ...preset, supportedProtocols }];
  });
}

export function tokenDanceError(status: number, recovery?: string | null): string {
  if (recovery === 'top_up_balance') return 'TokenDance 余额不足，请前往官网充值。';
  if (recovery === 'api_key_quota') return 'TokenDance 密钥额度已用完，请等待额度刷新或重新授权。';
  if (recovery === 'reauthorize_api_key' || status === 401 || status === 403) return 'TokenDance 授权已失效，请重新连接。';
  if (status === 429) return 'TokenDance 请求受限（429），请稍后重试。';
  return `TokenDance 请求失败（${status}），请稍后重试。`;
}
