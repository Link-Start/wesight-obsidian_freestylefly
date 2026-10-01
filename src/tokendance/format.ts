export * from '../providers/format';
import { anthropicToOpenAI as toOpenAI, openAIToAnthropic as toAnthropic } from '../providers/format';

export function anthropicToOpenAI(body: unknown): Record<string, unknown> {
  try { return toOpenAI(body); }
  catch { throw new Error('TokenDance 兼容模式暂不支持此消息内容类型。'); }
}

export function openAIToAnthropic(body: unknown): Record<string, unknown> {
  try { return toAnthropic(body); }
  catch { throw new Error('TokenDance 返回了无效的工具参数。'); }
}
