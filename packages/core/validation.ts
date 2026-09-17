import { z } from 'zod';

export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const eventTypeSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export const endpointInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    url: z.string().url().max(2048),
    eventTypes: z
      .array(z.union([eventTypeSchema, z.literal('*')]))
      .min(1)
      .max(20),
    signingSecret: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
  })
  .strict();

export const publishInput = z
  .object({ id: idSchema.optional(), type: eventTypeSchema, data: z.record(z.unknown()) })
  .strict();
