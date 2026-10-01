import type { IncomingMessage } from 'node:http';
import { providerRequest, readProviderJson } from '../providers/transport';

export function tokenDanceRequest(url: string, options: Parameters<typeof providerRequest>[1] = {}): Promise<IncomingMessage> {
  return providerRequest(url, options, 'TokenDance');
}

export function readTokenDanceJson(response: IncomingMessage): Promise<unknown> {
  return readProviderJson(response, 'TokenDance');
}
