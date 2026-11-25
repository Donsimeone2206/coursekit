import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoursekit, type Coursekit } from '../src/server/index.js';

export const PASSWORD = 'test-password';

export async function createTestLms(): Promise<Coursekit> {
  return createCoursekit({
    databaseUrl: 'sqlite::memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'coursekit-test-')),
    webDir: false,
  });
}

export interface Client {
  cookie: string;
  get: <T = any>(path: string) => Promise<{ status: number; body: T }>;
  post: <T = any>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  put: <T = any>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  patch: <T = any>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  delete: <T = any>(path: string) => Promise<{ status: number; body: T }>;
}

export function client(lms: Coursekit, cookie = ''): Client {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await lms.app.request(path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed };
  };
  return {
    cookie,
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b = {}) => call('PUT', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    delete: (p) => call('DELETE', p),
  };
}

export async function login(lms: Coursekit, email: string, password = PASSWORD): Promise<Client> {
  const res = await lms.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return client(lms, cookie);
}

/** Admin, teacher and two students plus one published course with the teacher enrolled. */
export async function setupSchool(lms: Coursekit) {
  await lms.createUser({ name: 'Admin', email: 'admin@test.dev', password: PASSWORD, role: 'admin' });
  await lms.createUser({ name: 'Tina Teacher', email: 'teacher@test.dev', password: PASSWORD, role: 'instructor' });
  await lms.createUser({ name: 'Sam Student', email: 'sam@test.dev', password: PASSWORD });
  await lms.createUser({ name: 'Kim Student', email: 'kim@test.dev', password: PASSWORD });
  const admin = await login(lms, 'admin@test.dev');
  const teacher = await login(lms, 'teacher@test.dev');
  const sam = await login(lms, 'sam@test.dev');
  const kim = await login(lms, 'kim@test.dev');
  const created = await teacher.post<{ id: string; slug: string }>('/api/courses', {
    title: 'Testing 101',
    summary: 'All about tests',
    visibility: 'published',
  });
  const course = created.body;
  const detail = await teacher.get(`/api/courses/${course.id}`);
  const sectionId: string = detail.body.sections[0].id;
  return { admin, teacher, sam, kim, course, sectionId };
}
