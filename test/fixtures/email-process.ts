/**
 * A second (and third) Coursekit server process for test/email-delivery.test.ts: run twice at once
 * against one SQLite file to check that two processes never send the same email or digest.
 * Usage: node --import tsx email-process.ts <databaseUrl> <dataDir> <outbox|digests> <startAtMs> [nowIso]
 * Both processes wait until startAtMs, so they really do race.
 */
import { createCoursekit } from '../../src/server/index.js';

const [databaseUrl, dataDir, mode, startAt, now] = process.argv.slice(2);
const sent: string[] = [];
const lms = await createCoursekit({
  databaseUrl,
  dataDir,
  webDir: false,
  migrate: false,
  publicUrl: 'https://learn.example.test',
  email: {
    worker: false,
    transport: {
      name: 'Child',
      async send(message) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
        sent.push(message.id);
      },
    },
  },
});

const late = Date.now() - Number(startAt);
if (late > 0) console.error(`started ${late}ms late, so the processes may not overlap`);
await new Promise((resolve) => setTimeout(resolve, Math.max(0, -late)));

if (mode === 'digests') {
  const result = await lms.email.sendDigests({ now: new Date(now!) });
  console.log(JSON.stringify({ result }));
} else {
  while ((await lms.email.processOutbox()).sent > 0) {
    // keep delivering until the outbox is empty
  }
  console.log(JSON.stringify({ sent }));
}
await lms.close();
