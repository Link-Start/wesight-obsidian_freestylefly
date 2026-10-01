import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeChatAsMessages as pipe } from '../providers/stream';

export function pipeChatAsMessages(upstream: IncomingMessage, response: ServerResponse, model: string, signal?: AbortSignal): Promise<void> {
  return pipe(upstream, response, model, signal, 'TokenDance');
}
