import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createCoursekit,
  type AppEnv,
  type CourseDetail,
  type CoursekitEvents,
  type CreateCoursekitOptions,
  type CreateUserInput,
  type DatabaseKind,
  type DB,
  type SeedDemoOptions,
  type SeedDemoResult,
  type User,
} from 'coursekit-lms';

// The README's library example: passing a possibly-undefined value must type-check.
const options: CreateCoursekitOptions = { databaseUrl: process.env.DATABASE_URL, publicUrl: undefined, webDir: false };
const lms = await createCoursekit(options);

lms.events.on('grade.updated', (event: CoursekitEvents['grade.updated']) => {
  const score: number | null = event.score;
  void score;
});
// @ts-expect-error unknown event names are rejected, so the types are real (not any)
lms.events.on('grade.updatd', () => {});

const user: User = await lms.createUser({ name: 'Ada', email: 'ada@example.test', password: undefined });
// @ts-expect-error the public user never exposes the password hash
void user.passwordHash;

// Node's types come through the package's own declarations.
const handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = lms.handler;
void handler;

declare const course: CourseDetail;
const firstTitle: string | undefined = course.sections[0]?.activities[0]?.title;
void firstTitle;

// Option and result types can be imported by name.
const input: CreateUserInput = { name: 'Grace', email: 'grace@example.test', role: undefined };
void input;
const seedOptions: SeedDemoOptions = { admin: user, password: undefined };
const seeded: SeedDemoResult = await lms.seedDemo(seedOptions);
const kind: DatabaseKind = lms.dbKind;
const db: DB = lms.db;
const app: import('hono').Hono<AppEnv> = lms.app;
void seeded;
void kind;
void db;
void app;

await lms.close();
