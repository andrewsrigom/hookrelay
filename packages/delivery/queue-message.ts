import { z } from 'zod';
import { idSchema } from '../core/validation.js';

export const queueMessageSchema = z.object({
  id: idSchema,
  deliveryId: idSchema,
  expectedAttempt: z.number().int().positive(),
  route: z.enum(['delivery', 'dead-letter']),
  availableAt: z.number().finite().nonnegative(),
});
