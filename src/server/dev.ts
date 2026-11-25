/** Development API server (`npm run dev:api`). The web UI is served by Vite on :5173. */
import { styleText } from 'node:util';
import { createCoursekit } from './index.js';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env file
}

// In development PORT belongs to the Vite web server; the API listens on its own port behind Vite's proxy.
const apiPort = Number(process.env.COURSEKIT_API_PORT ?? 3000);
const webPort = Number(process.env.PORT ?? 5173);
const lms = await createCoursekit({ webDir: false, port: apiPort, logRequests: process.env.COURSEKIT_LOG !== '0' });
const { url } = await lms.listen();
console.log(
  `\n  ${styleText('bold', 'Coursekit API')} ${styleText('dim', `v${lms.version}`)} running at ${styleText('cyan', url)}` +
    `\n  Database: ${lms.dbKind}  ·  Open the app at ${styleText('cyan', `http://localhost:${webPort}`)}\n`,
);

const shutdown = async () => {
  await lms.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
