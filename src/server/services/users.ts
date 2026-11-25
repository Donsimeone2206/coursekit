import type { SiteRole } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { conflict } from '../lib/http.js';
import { hashPassword } from '../lib/password.js';
import { newId, now } from '../lib/util.js';

export interface CreateUserInput {
  name: string;
  email: string;
  password?: string | null;
  /** Pre-computed hash, e.g. when seeding many users with the same password. */
  passwordHash?: string | null;
  role?: SiteRole;
  bio?: string | null;
  avatarUrl?: string | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createUser(deps: Pick<AppDeps, 'db' | 'events'>, input: CreateUserInput): Promise<UserRow> {
  const email = normalizeEmail(input.email);
  const existing = await deps.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) throw conflict('An account with this email already exists.');

  const ts = now();
  const user: UserRow = {
    id: newId(),
    email,
    name: input.name.trim(),
    passwordHash: input.passwordHash ?? (input.password ? await hashPassword(input.password) : null),
    role: input.role ?? 'student',
    avatarUrl: input.avatarUrl ?? null,
    bio: input.bio ?? null,
    status: 'active',
    lastLoginAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await deps.db.insertInto('users').values(user).execute();
  deps.events.emit('user.created', { userId: user.id, email: user.email, role: user.role });
  return user;
}
