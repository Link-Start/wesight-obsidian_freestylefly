// Model manufacturers are independent of the provider used to route requests.
export const ModelVendor = {
  OpenAI: 'openai',
  Google: 'google',
  Anthropic: 'anthropic',
  DeepSeek: 'deepseek',
  Moonshot: 'moonshot',
  Qwen: 'qwen',
  Zhipu: 'zhipu',
  Minimax: 'minimax',
  Meta: 'meta',
  Mistral: 'mistral',
  XAI: 'xai',
  Volcengine: 'volcengine',
  Xiaomi: 'xiaomi',
  StepFun: 'stepfun',
  Other: 'other',
} as const;
export type ModelVendor = typeof ModelVendor[keyof typeof ModelVendor];

export const MODEL_VENDOR_LABELS: Record<ModelVendor, string> = {
  [ModelVendor.OpenAI]: 'OpenAI',
  [ModelVendor.Google]: 'Google',
  [ModelVendor.Anthropic]: 'Anthropic',
  [ModelVendor.DeepSeek]: 'DeepSeek',
  [ModelVendor.Moonshot]: 'Moonshot',
  [ModelVendor.Qwen]: 'Qwen',
  [ModelVendor.Zhipu]: 'Zhipu',
  [ModelVendor.Minimax]: 'MiniMax',
  [ModelVendor.Meta]: 'Meta',
  [ModelVendor.Mistral]: 'Mistral',
  [ModelVendor.XAI]: 'xAI',
  [ModelVendor.Volcengine]: 'Volcengine',
  [ModelVendor.Xiaomi]: 'Xiaomi',
  [ModelVendor.StepFun]: 'StepFun',
  [ModelVendor.Other]: '其他',
};
