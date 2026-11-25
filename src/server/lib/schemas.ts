import { z } from 'zod';

export const nameSchema = z.string().trim().min(1, 'Enter a name').max(100);
export const emailSchema = z.email('Enter a valid email address').max(254);
export const passwordSchema = z.string().min(8, 'Use at least 8 characters').max(200);
export const siteRoleSchema = z.enum(['admin', 'instructor', 'student']);
export const courseRoleSchema = z.enum(['teacher', 'assistant', 'student']);

/** Any date string `Date` understands; stored as a normalized ISO timestamp. */
export const isoDateSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date')
  .transform((v) => new Date(v).toISOString());

export const markdownSchema = (max = 200_000) => z.string().max(max);

export const pageSchema = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

/** Avatar and cover images must be uploaded files or https URLs. */
export const imageUrlSchema = z
  .string()
  .max(500)
  .regex(/^(\/api\/files\/[0-9a-z]+|https:\/\/\S+)$/, 'Use an uploaded image or an https URL');
