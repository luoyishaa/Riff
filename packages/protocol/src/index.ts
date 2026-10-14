import { z } from 'zod';

export const principalSchema = z.object({
  id: z.string(),
  kind: z.enum(['human', 'agent']),
  displayName: z.string(),
  ownerId: z.string().optional(),
});
export const documentSchema = z.object({ id: z.string(), title: z.string(), text: z.string() });
export type PrincipalDto = z.infer<typeof principalSchema>;
export type DocumentDto = z.infer<typeof documentSchema>;
