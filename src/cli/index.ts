#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs, styleText } from 'node:util';
import { createCoursekit, type CreateCoursekitOptions } from '../server/index.js';
import { packageName, packageVersion } from '../server/paths.js';

const bold = (s: string) => styleText('bold', s);
const dim = (s: string) => styleText('dim', s);
const cyan = (s: string) => styleText('cyan', s);
const green = (s: string) => styleText('green', s);
const red = (s: string) => styleText('red', s);

const HELP = `
${bold('Coursekit')} ${dim(`v${packageVersion()}`)}: open-source learning management system

${bold('Usage')}
  coursekit <command> [options]

${bold('Commands')}
  start           Start the web server (runs migrations first)
  init [dir]      Create a new Coursekit site in a folder
  migrate         Apply pending database migrations
  seed --demo     Load demo courses, people and activity
  create-admin    Create an administrator account
  send-digests    Send due email digests and deliver queued email (for cron)

${bold('Options')}
  -p, --port <n>           Port to listen on ${dim('(default 3000, or $PORT)')}
      --host <host>        Interface to bind ${dim('(default 0.0.0.0)')}
      --database-url <url> sqlite://path.db or postgres://... ${dim('(or $DATABASE_URL)')}
      --data-dir <dir>     Uploads and the default SQLite file ${dim('(default ./data)')}
      --email, --name, --password   Account details for init / create-admin
      --demo               Add demo content (init, seed)
      --force              send-digests: send the current digests even outside the digest hour
  -y, --yes                Accept defaults without prompting
  -v, --version            Print the version
  -h, --help               Show this help

${bold('Examples')}
  npx coursekit-lms start
  npx coursekit-lms init my-school --demo
  DATABASE_URL=postgres://localhost/lms coursekit start
`;

function loadEnv() {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env in the current folder
  }
}

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question}${fallback ? dim(` (${fallback})`) : ''}: `);
  rl.close();
  return answer.trim() || fallback;
}

/** Reads a line without echoing it (falls back to a normal prompt when stdin is not a TTY). */
async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stdout.write(`${question}: `);
  return new Promise((resolvePromise) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolvePromise(value);
          return;
        }
        if (char === '\u0003') process.exit(130);
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      'database-url': { type: 'string' },
      'data-dir': { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
      demo: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.version) return console.log(packageVersion());
  const [command = 'help', ...rest] = positionals;
  if (values.help || command === 'help') return console.log(HELP);

  if (command === 'init') {
    const dir = resolve(rest[0] ?? '.');
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    if (!existsSync('.env')) {
      writeFileSync(
        '.env',
        [
          'PORT=3000',
          'DATABASE_URL=sqlite://./data/coursekit.db',
          'COURSEKIT_DATA_DIR=./data',
          '# COURSEKIT_PUBLIC_URL=https://learn.example.com',
          '# Behind a reverse proxy on this machine (for the client address in rate limits):',
          '# COURSEKIT_TRUST_PROXY=loopback',
          '# Email: an SMTP server (npm install nodemailer), or COURSEKIT_MAIL_TRANSPORT=log to print emails instead',
          '# COURSEKIT_SMTP_URL=smtp://user:password@smtp.example.com:587',
          '# COURSEKIT_MAIL_FROM=Coursekit <no-reply@example.com>',
          '',
        ].join('\n'),
      );
    }
    if (!existsSync('package.json')) {
      const pkg = {
        name:
          dir
            .split(/[\\/]/)
            .pop()
            ?.toLowerCase()
            .replace(/[^a-z0-9-]/g, '-') || 'coursekit-site',
        private: true,
        type: 'module',
        scripts: { start: 'coursekit start', migrate: 'coursekit migrate' },
        dependencies: { [packageName()]: `^${packageVersion()}` },
      };
      writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    }
    if (!existsSync('.gitignore')) writeFileSync('.gitignore', 'node_modules/\ndata/\n.env\n');
  }

  loadEnv();
  const options: CreateCoursekitOptions = {
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    databaseUrl: values['database-url'],
    dataDir: values['data-dir'],
    // Only the web server delivers email in the background; one-off commands never send.
    email: command === 'start' ? undefined : { worker: false },
  };

  switch (command) {
    case 'start': {
      const lms = await createCoursekit(options);
      if (!lms.config.webDir) {
        console.warn(red('The web UI has not been built. Run `npm run build` (or use `npm run dev` while developing).'));
      }
      const { url } = await lms.listen();
      const users = await lms.db
        .selectFrom('users')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirst();
      console.log(`\n  ${bold('Coursekit')} ${dim(`v${lms.version}`)} is running at ${cyan(url)}`);
      console.log(`  ${dim('Database:')} ${lms.dbKind}   ${dim('Data:')} ${lms.config.dataDir}`);
      if (Number(users?.n ?? 0) === 0) console.log(`\n  ${green('→')} Open ${cyan(url)} to create your administrator account.`);
      console.log('');
      const stop = async () => {
        await lms.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }

    case 'migrate': {
      const lms = await createCoursekit({ ...options, migrate: false });
      await lms.migrate();
      console.log(green('✓ Database is up to date.'));
      return lms.close();
    }

    case 'seed': {
      if (!values.demo) {
        console.log('Usage: coursekit seed --demo [--password <password>]');
        return;
      }
      const lms = await createCoursekit(options);
      const password = values.password ?? 'coursekit';
      const result = await lms.seedDemo({ password });
      if (!result.created) console.log(dim('Demo content is already loaded.'));
      else {
        console.log(green(`✓ Added ${result.courses} demo courses and ${result.users.length} people.`));
        console.log(`\n  Sign in with any demo account, password ${bold(password)}:`);
        for (const u of result.users.slice(0, 5)) console.log(`  ${dim(u.role.padEnd(10))} ${u.email}`);
        console.log(dim(`  …and ${Math.max(0, result.users.length - 5)} more\n`));
      }
      return lms.close();
    }

    case 'send-digests': {
      const lms = await createCoursekit(options);
      if (!lms.email.enabled) {
        console.error(red('Email is not set up. Set COURSEKIT_SMTP_URL (or COURSEKIT_MAIL_TRANSPORT=log) first.'));
        process.exitCode = 1;
        return lms.close();
      }
      const digests = await lms.email.sendDigests({ force: values.force });
      const delivered = { sent: 0, failed: 0, retrying: 0 };
      // Each delivery run is time-boxed: keep going while it makes progress.
      while (true) {
        const run = await lms.email.processOutbox();
        delivered.sent += run.sent;
        delivered.failed += run.failed;
        delivered.retrying += run.retrying;
        if (run.sent === 0) break;
      }
      console.log(
        green(`✓ Queued ${digests.daily} daily and ${digests.weekly} weekly digests`) +
          dim(` (${digests.skipped} ${digests.skipped === 1 ? 'person had' : 'people had'} nothing new)`),
      );
      console.log(
        `  Sent ${delivered.sent} ${delivered.sent === 1 ? 'email' : 'emails'}` +
          (delivered.retrying ? `, ${delivered.retrying} will be retried` : '') +
          (delivered.failed ? red(`, ${delivered.failed} failed`) : ''),
      );
      if (delivered.failed) process.exitCode = 1;
      return lms.close();
    }

    case 'init':
    case 'create-admin': {
      const lms = await createCoursekit(options);
      const interactive = !values.yes && process.stdin.isTTY;
      const name = values.name ?? (interactive ? await ask('Administrator name', 'Admin') : 'Admin');
      const email = values.email ?? (interactive ? await ask('Administrator email') : '');
      let password = values.password ?? (interactive ? await askHidden('Password (8+ characters)') : '');
      if (!email || !email.includes('@')) {
        console.error(red('A valid --email is required.'));
        process.exitCode = 1;
        return lms.close();
      }
      if (password.length < 8) {
        console.error(red('The password must be at least 8 characters.'));
        process.exitCode = 1;
        return lms.close();
      }
      try {
        const admin = await lms.createUser({ name, email, password, role: 'admin' });
        console.log(green(`✓ Created administrator ${admin.email}`));
        if (command === 'init' && values.demo) {
          await lms.seedDemo({ admin });
          console.log(green('✓ Added demo content. Use "Log in as" in Admin → Users to explore as a student.'));
        }
      } catch (err) {
        console.error(red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
      password = '';
      if (command === 'init') {
        console.log(`\n  Next steps:\n    ${cyan(`cd ${rest[0] ?? '.'}`)}\n    ${cyan('npm install')}\n    ${cyan('npm start')}\n`);
      }
      return lms.close();
    }

    default:
      console.error(red(`Unknown command "${command}".`));
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
