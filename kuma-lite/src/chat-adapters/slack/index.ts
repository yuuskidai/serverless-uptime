/*
 * Public entry for the Workers-native Slack adapter.
 *
 * Usage:
 *
 *   import { Chat } from "chat";
 *   import { createSlackAdapter } from "./chat-adapters/slack";
 *
 *   const bot = new Chat({
 *     userName: "kuma-lite",
 *     adapters: {
 *       slack: createSlackAdapter({
 *         botToken: env.SLACK_BOT_TOKEN,
 *         signingSecret: env.SLACK_SIGNING_SECRET,
 *       }),
 *     },
 *   });
 */

export {
  SlackWorkersAdapter,
  encodeSlackThreadId,
  decodeSlackThreadId,
  type SlackAdapterConfig,
  type SlackThreadId,
  type SlackRawMessage,
} from './adapter';
export { SlackClient, postToResponseUrl } from './client';
export { verifySlackRequest, type VerifyResult } from './signing';
export {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ValidationError,
} from './errors';

import { SlackWorkersAdapter, type SlackAdapterConfig } from './adapter';

export function createSlackAdapter(config: SlackAdapterConfig): SlackWorkersAdapter {
  return new SlackWorkersAdapter(config);
}
