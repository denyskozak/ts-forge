import { z } from 'zod';
export const mcpProfileSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    transport: z.enum(['stdio', 'http']),
    command: z.string().max(4000).default(''),
    args: z.array(z.string().max(4000)).max(40).default([]),
    url: z.string().max(2000).default(''),
    envNames: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
      .max(20)
      .default([]),
    tokenEnv: z
      .string()
      .regex(/^(?:[A-Z_][A-Z0-9_]*)?$/)
      .default(''),
    enabled: z.boolean().default(false),
    allowedTools: z.array(z.string().min(1).max(200)).max(100).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'stdio' && !value.command.trim())
      ctx.addIssue({ code: 'custom', message: 'A stdio server needs an executable.' });
    if (value.transport === 'http') {
      try {
        const url = new URL(value.url);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !(url.protocol === 'https:' || (url.protocol === 'http:' && local))
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Use HTTPS or loopback HTTP without inline credentials or query parameters.',
        });
      }
    }
  });
export type McpProfile = z.infer<typeof mcpProfileSchema>;
export interface McpConnection {
  id: string;
  name: string;
  connected: boolean;
  server?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  tools: {
    name: string;
    description?: string;
    allowed: boolean;
    inputSchema: Record<string, unknown>;
  }[];
  error?: string;
}
