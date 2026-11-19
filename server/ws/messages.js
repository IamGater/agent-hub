// @ts-check
import { z } from 'zod';

const agentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const clientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('subscribe'), agentId }),
  z.strictObject({ type: z.literal('unsubscribe'), agentId }),
  z.strictObject({ type: z.literal('input'), agentId, data: z.string().min(1).max(4096) }),
  z.strictObject({
    type: z.literal('resize'),
    agentId,
    cols: z.int().min(20).max(400),
    rows: z.int().min(5).max(200),
  }),
  z.strictObject({ type: z.literal('mode') }),
  // The socket payload limit is 16 KiB; 6000 characters fit even when every one takes two bytes.
  z.strictObject({ type: z.literal('chat-send'), agentId, text: z.string().trim().min(1).max(6000) }),
  z.strictObject({
    type: z.literal('chat-answer'),
    agentId,
    requestId: z.string().min(1).max(128),
    allow: z.boolean(),
  }),
  z.strictObject({ type: z.literal('chat-interrupt'), agentId }),
  z.strictObject({ type: z.literal('chat-unqueue'), agentId, itemId: z.string().min(1).max(64) }),
  z.strictObject({ type: z.literal('chat-link'), agentId, peer: agentId, hops: z.int().min(1).max(20) }),
  z.strictObject({ type: z.literal('chat-unlink'), agentId }),
]);

/** @typedef {z.infer<typeof clientMessage>} ClientMessage */

/**
 * @typedef {{ type: 'hello', mode: 'view' | 'control', remainingMs: number | null, agents: unknown[] }
 *   | { type: 'mode', mode: 'view' | 'control', remainingMs: number | null }
 *   | { type: 'agent', agent: unknown }
 *   | { type: 'snapshot', agentId: string, data: string }
 *   | { type: 'output', agentId: string, data: string }
 *   | { type: 'chat-snapshot', agentId: string, items: unknown[] }
 *   | { type: 'chat-item', agentId: string, item: unknown }
 *   | { type: 'chat-delta', agentId: string, itemId: string, text: string }
 *   | { type: 'chat-commands', agentId: string, commands: unknown[] }
 *   | { type: 'error', code: string }} ServerMessage
 */
