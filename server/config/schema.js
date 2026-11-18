// @ts-check
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_ENV = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

const DEFAULT_PROMPTS = [
  '\\(y/n\\)',
  '\\[y/N\\]',
  '\\[Y/n\\]',
  'Do you want to',
  'Allow (this|command|execution)',
  'Approve',
  'Proceed\\?',
  'Press Enter to',
  'Yes, and',
];

// Limits are upper bounds from the spec: the config can make them stricter, never looser.
export const configSchema = z.strictObject({
  // Remote origin for the phone (tailscale serve). Without it only the local web UI exists.
  origin: z.url().optional(),
  port: z.int().min(1024).max(65535).default(8780),
  remotePort: z.int().min(1024).max(65535).default(8781),
  tailscaleUser: z.string().min(1).max(256).optional(),
  rpName: z.string().min(1).max(64).default('Agent Hub'),
  dataDir: z.string().min(1).default('./data'),
  agentsFile: z.string().min(1).default('./agents.json'),
  allowedRoots: z.array(z.string().min(1)).min(1),
  stepupMinutes: z.number().positive().max(5).default(5),
  sessionHours: z.number().positive().max(12).default(12),
  idleMinutes: z.number().positive().max(30).default(30),
  bufferBytes: z
    .int()
    .min(64 * 1024)
    .max(16 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  prompt: z
    .strictObject({
      idleMs: z.int().min(300).max(60000).default(1500),
      patterns: z.array(z.string().min(1).max(200)).default(DEFAULT_PROMPTS),
    })
    .default({ idleMs: 1500, patterns: DEFAULT_PROMPTS }),
  agentEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_()]*$/)).default(DEFAULT_ENV),
  logInputText: z.boolean().default(false),
  ntfy: z
    .strictObject({
      url: z.url({ protocol: /^https$/ }),
      topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    })
    .optional(),
});

/** @typedef {z.infer<typeof configSchema>} Config */

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The owner approves agent actions from the UI; a mode that skips approvals would make that moot.
// Substring match on purpose: it also catches --flag=value and -c key=value spellings.
const AUTO_APPROVE = [
  'dangerously',
  'yolo',
  'full-auto',
  'bypasspermissions',
  'acceptedits',
  'dontask',
  'danger-full-access',
];

/**
 * Returns the first argument that turns on an auto-approve or sandbox-bypass mode, or null.
 * @param {string[]} args
 */
export function autoApproveArg(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase().replace(/[\s"']/g, '');
    if (AUTO_APPROVE.some((w) => a.includes(w))) return args[i];
    if (/approval(_policy|-policy)?=never|ask-for-approval=never/.test(a)) return args[i];
    if ((a === '-a' || a === '--ask-for-approval') && args[i + 1]?.toLowerCase() === 'never') return args[i];
  }
  return null;
}

export const agentSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    name: z.string().min(1).max(64),
    // "terminal" runs any CLI in a pseudo-terminal. "claude" and "codex" run that agent in its machine
    // protocol and show it as a chat; the server then sets every flag itself.
    type: z.enum(['terminal', 'claude', 'codex', 'antigravity']).default('terminal'),
    // Absolute only: Windows searches the working directory first, where an agent could plant a binary.
    // No characters cmd.exe would interpret, since a .cmd shim is started through it.
    command: z
      .string()
      .max(1024)
      .refine((p) => path.isAbsolute(p), 'command must be an absolute path')
      .refine((p) => !/["%&|<>^!]/.test(p), 'command contains characters that are not allowed'),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:[\]-]{1,64}$/)
      .optional(),
    args: z
      .array(z.string().max(1024))
      .max(64)
      .default([])
      .refine((a) => autoApproveArg(a) === null, {
        message: 'auto-approve and sandbox-bypass flags are not allowed',
      }),
    cwd: z.string().min(1).max(1024),
    env: z.record(z.string().regex(envName), z.string().max(4096)).default({}),
  })
  .refine((a) => a.type === 'terminal' || a.args.length === 0, {
    message: 'chat agents take no args: the server sets the flags (use "model" to pick a model)',
    path: ['args'],
  })
  .refine((a) => a.type !== 'terminal' || a.model === undefined, {
    message: '"model" is only for chat agents; pass it in args instead',
    path: ['model'],
  });

export const agentsSchema = z.array(agentSchema).max(32);

/** @typedef {z.infer<typeof agentSchema>} Agent */
