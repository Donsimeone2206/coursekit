import { expect, it } from 'vitest';
import { createCoursekit } from '../src/server/index.js';

it('seedDemo without a password returns the one it gave the new administrator', async () => {
  const lms = await createCoursekit({ databaseUrl: 'sqlite::memory:', webDir: false });
  try {
    const result = await lms.seedDemo();
    expect(result.created).toBe(true);
    expect(typeof result.password).toBe('string');

    const res = await lms.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@coursekit.test', password: result.password }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { role: string } }).user.role).toBe('admin');
  } finally {
    await lms.close();
  }
});
