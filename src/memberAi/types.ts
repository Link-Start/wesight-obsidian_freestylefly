export interface MemberAiStatus {
  state:
    | 'login-required'
    | 'checking'
    | 'ready'
    | 'membership-required'
    | 'expired'
    | 'quota-exhausted'
    | 'unavailable';
  membership: { active: boolean; expiresAt: string | null };
  models: { id: string; name: string }[];
  defaultModel: string;
  quota: { remainingPercent: number; resetsAt: string | null };
  gatewayUrl: string | null;
}
export const EMPTY_MEMBER_AI_STATUS: MemberAiStatus = {
  state: 'checking',
  membership: { active: false, expiresAt: null },
  models: [],
  defaultModel: '',
  quota: { remainingPercent: 0, resetsAt: null },
  gatewayUrl: null,
};
export const MEMBER_AI_MESSAGES: Record<MemberAiStatus['state'], string> = {
  checking: '正在检查会员模型…',
  'login-required': '登录 WeSight 后即可查看会员模型权益。',
  'membership-required': '开通 WeSight 会员即可使用内置模型，每周额度独立于积分。',
  expired: '会员已到期，续费后可继续使用。',
  ready: '已就绪，无需配置 API Key。',
  'quota-exhausted': '本周额度已用完，请等待恢复或切换自定义配置。',
  unavailable: '会员模型暂未开放或服务不可用，请稍后刷新。',
};
