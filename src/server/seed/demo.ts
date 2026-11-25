/**
 * Demo content: a handful of realistic courses with teachers, students, lessons,
 * graded work, quiz attempts and forum threads. Dates are relative to "now" so the
 * demo always has upcoming deadlines.
 */
import type { Insertable } from 'kysely';
import type { ActivitySettingsMap, ActivityType, AttemptAnswer, CourseRole, QuestionType } from '../../shared/types.js';
import type { AppDeps } from '../context.js';
import type {
  ActivitiesTable,
  AnnouncementsTable,
  CalendarEventsTable,
  CompletionsTable,
  CoursesTable,
  Database,
  DiscussionsTable,
  EnrolmentsTable,
  GradesTable,
  NotificationsTable,
  PostsTable,
  QuestionsTable,
  QuizAttemptsTable,
  SectionsTable,
  SubmissionsTable,
  UserRow,
} from '../db/schema.js';
import { hashPassword } from '../lib/password.js';
import { newId, randomToken, round } from '../lib/util.js';
import { gradeQuestion } from '../services/quiz.js';

export interface SeedDemoOptions {
  /** Administrator that owns the demo. If omitted, the first admin is used (or one is created). */
  admin?: UserRow;
  /** Password for all demo accounts. Defaults to a random one (admins can still use "Log in as"). */
  password?: string;
}

export interface SeedDemoResult {
  created: boolean;
  password: string | null;
  users: Array<{ name: string; email: string; role: string }>;
  courses: number;
}

// Deterministic pseudo-random numbers so the demo looks the same every time.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const at = (days: number, hour = 9, minute = 0) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
};

type Q = {
  type: QuestionType;
  prompt: string;
  points?: number;
  options?: Array<[string, boolean]>;
  accepted?: string[];
  tolerance?: number;
  explanation?: string;
};

type ActivitySpec =
  | { type: 'lesson'; title: string; minutes: number; body: string; description?: string; completion?: 'manual' | 'auto' | 'none' }
  | { type: 'resource'; title: string; url: string; description?: string }
  | { type: 'assignment'; title: string; due: number; points?: number; description: string; types?: Array<'text' | 'file'> }
  | { type: 'quiz'; title: string; due?: number; description: string; questions: Q[]; timeLimit?: number; attempts?: number }
  | { type: 'forum'; title: string; description: string; studentsStart?: boolean };

interface CourseSpec {
  slug: string;
  title: string;
  category: string;
  cover: string;
  summary: string;
  description: string;
  teacher: string;
  assistant?: string;
  visibility?: 'draft' | 'published';
  enrolment?: 'open' | 'key';
  key?: string;
  start: number;
  end: number;
  sections: Array<{ title: string; summary?: string; activities: ActivitySpec[] }>;
}

const PEOPLE = {
  maya: {
    name: 'Maya Chen',
    email: 'maya.chen@coursekit.test',
    role: 'instructor',
    bio: 'Front-end engineer turned educator. Ten years of building for the web.',
  },
  daniel: {
    name: 'Daniel Okafor',
    email: 'daniel.okafor@coursekit.test',
    role: 'instructor',
    bio: 'Data scientist and product lead. Loves a good spreadsheet.',
  },
  priya: {
    name: 'Priya Raman',
    email: 'priya.raman@coursekit.test',
    role: 'student',
    bio: 'Teaching assistant for Modern Web Development.',
  },
  alex: { name: 'Alex Johnson', email: 'alex.johnson@coursekit.test', role: 'student', bio: 'Career switcher learning to code.' },
  sofia: { name: 'Sofia Martinez', email: 'sofia.martinez@coursekit.test', role: 'student' },
  liam: { name: "Liam O'Brien", email: 'liam.obrien@coursekit.test', role: 'student' },
  emma: { name: 'Emma Wilson', email: 'emma.wilson@coursekit.test', role: 'student' },
  noah: { name: 'Noah Kim', email: 'noah.kim@coursekit.test', role: 'student' },
  olivia: { name: 'Olivia Brown', email: 'olivia.brown@coursekit.test', role: 'student' },
  ethan: { name: 'Ethan Davis', email: 'ethan.davis@coursekit.test', role: 'student' },
  ava: { name: 'Ava Thompson', email: 'ava.thompson@coursekit.test', role: 'student' },
  lucas: { name: 'Lucas Silva', email: 'lucas.silva@coursekit.test', role: 'student' },
  mia: { name: 'Mia Garcia', email: 'mia.garcia@coursekit.test', role: 'student' },
  james: { name: 'James Lee', email: 'james.lee@coursekit.test', role: 'student' },
  zara: { name: 'Zara Ahmed', email: 'zara.ahmed@coursekit.test', role: 'student' },
} as const;
type Person = keyof typeof PEOPLE;

const CATEGORIES = [
  ['Computer Science', 'Programming, software engineering and the web.'],
  ['Data & AI', 'Statistics, data analysis and machine learning.'],
  ['Design', 'User experience, visual design and research.'],
  ['Business', 'Product, strategy and leadership.'],
  ['Languages', 'Learn to speak, read and write a new language.'],
] as const;

const COURSES: CourseSpec[] = [
  {
    slug: 'modern-web-development',
    title: 'Modern Web Development',
    category: 'Computer Science',
    cover: 'ocean',
    summary: 'Build fast, accessible websites with HTML, CSS, JavaScript and React, from your first page to a deployed app.',
    description: `## About this course

This hands-on course takes you from your first HTML page to a deployed React application. Every week mixes short lessons, a quiz to check your understanding and a practical assignment.

### What you'll learn

- Write **semantic, accessible HTML** and modern CSS layouts with Flexbox and Grid
- Understand JavaScript fundamentals: values, functions, the DOM and events
- Build interactive interfaces with **React components, state and effects**
- Ship a complete project and get feedback from your peers

### How it works

1. Work through each section in order. Most lessons take 10–15 minutes.
2. Complete the quiz at the end of each section. You can retake most quizzes.
3. Submit the assignment before its due date. Your teacher will leave feedback.

> Stuck? Post in the **Introductions** forum or join the weekly live Q&A.`,
    teacher: 'maya',
    assistant: 'priya',
    start: -30,
    end: 60,
    sections: [
      {
        title: 'Welcome',
        summary: 'Start here: meet your classmates and learn how the course works.',
        activities: [
          {
            type: 'lesson',
            title: 'Welcome to the course',
            minutes: 5,
            body: `# Welcome! 👋

I'm Maya, and I'll be your guide through **Modern Web Development**. Over the next ten weeks you'll go from writing your first HTML page to deploying a real React app.

## How to succeed in this course

- **Show up regularly.** A little every day beats a marathon on Sunday.
- **Type the code yourself.** Copy-pasting skips the part where you learn.
- **Ask questions early.** The forum is there for exactly that.

## What you need

| Tool | Why |
| --- | --- |
| A modern browser | Chrome, Firefox, Safari or Edge |
| A code editor | VS Code is a great free choice |
| Node.js 22+ | For the React section later on |

When you're ready, mark this lesson as done and say hello in the **Introductions** forum.`,
          },
          {
            type: 'forum',
            title: 'Introductions',
            description: 'Tell us who you are, where you are learning from and what you want to build.',
            studentsStart: true,
          },
          {
            type: 'resource',
            title: 'MDN Web Docs',
            url: 'https://developer.mozilla.org/',
            description: 'The reference we will use throughout the course.',
          },
        ],
      },
      {
        title: 'HTML & CSS Foundations',
        summary: 'Structure content with semantic HTML and lay it out with modern CSS.',
        activities: [
          {
            type: 'lesson',
            title: 'How the web works',
            minutes: 8,
            body: `# How the web works

When you type an address into your browser, a surprising amount happens in a few hundred milliseconds.

1. **DNS lookup**: the browser asks a DNS server for the IP address behind the domain name.
2. **Connection**: it opens a TCP connection (and negotiates TLS for \`https://\`).
3. **Request**: it sends an HTTP request such as \`GET /index.html\`.
4. **Response**: the server answers with a status code, headers and a body.
5. **Rendering**: the browser parses HTML, fetches CSS and JavaScript, and paints the page.

\`\`\`http
GET /courses HTTP/1.1
Host: example.com
Accept: text/html
\`\`\`

> **Key idea:** HTML describes *structure*, CSS describes *presentation* and JavaScript adds *behaviour*. Keeping them separate keeps your projects maintainable.`,
          },
          {
            type: 'lesson',
            title: 'Semantic HTML',
            minutes: 12,
            body: `# Semantic HTML

Semantic elements describe the *meaning* of content, not how it looks. Screen readers, search engines and your future self all benefit.

\`\`\`html
<header>
  <nav aria-label="Main">
    <a href="/">Home</a>
    <a href="/courses">Courses</a>
  </nav>
</header>
<main>
  <article>
    <h1>Semantic HTML</h1>
    <p>Use the element that matches the meaning of your content.</p>
  </article>
  <aside>Related lessons</aside>
</main>
<footer>© 2026</footer>
\`\`\`

## Rules of thumb

- One \`<h1>\` per page, and don't skip heading levels.
- Use \`<button>\` for actions and \`<a>\` for navigation.
- Every image that carries meaning needs useful \`alt\` text.`,
          },
          {
            type: 'lesson',
            title: 'Modern CSS layout: Flexbox and Grid',
            minutes: 15,
            body: `# Modern CSS layout

Two layout systems cover almost every design you'll meet.

## Flexbox: one dimension

Use Flexbox to distribute items along a **row or a column**.

\`\`\`css
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
\`\`\`

## Grid: two dimensions

Use Grid when you need **rows and columns** at the same time.

\`\`\`css
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 1.5rem;
}
\`\`\`

> Try it: resize your browser window and watch the cards reflow without a single media query.`,
          },
          {
            type: 'quiz',
            title: 'HTML & CSS check-in',
            due: -3,
            description: 'Six quick questions on semantic HTML and CSS layout. You have two attempts; your highest score counts.',
            attempts: 2,
            questions: [
              {
                type: 'single',
                prompt: 'Which element should wrap the main navigation links of a page?',
                options: [
                  ['`<nav>`', true],
                  ['`<menu>`', false],
                  ['`<div class="nav">`', false],
                  ['`<section>`', false],
                ],
                explanation: '`<nav>` tells assistive technology that the links are a navigation landmark.',
              },
              {
                type: 'multiple',
                prompt: 'Which of these are semantic HTML elements? Select all that apply.',
                options: [
                  ['`<article>`', true],
                  ['`<aside>`', true],
                  ['`<span>`', false],
                  ['`<footer>`', true],
                  ['`<b>`', false],
                ],
              },
              {
                type: 'truefalse',
                prompt: 'CSS Grid can only be used for two-dimensional layouts.',
                options: [
                  ['True', false],
                  ['False', true],
                ],
                explanation: 'Grid works perfectly well for a single row or column too, although Flexbox is often simpler there.',
              },
              {
                type: 'short',
                prompt: 'Which declaration turns an element into a flex container? Answer in the form `property: value`.',
                accepted: ['display: flex', 'display:flex', 'display: inline-flex'],
              },
              {
                type: 'numeric',
                prompt: 'How many columns does `grid-template-columns: repeat(3, 1fr) 200px` create?',
                accepted: ['4'],
              },
              {
                type: 'single',
                prompt: 'Which CSS unit is relative to the font size of the root element?',
                options: [
                  ['`rem`', true],
                  ['`em`', false],
                  ['`px`', false],
                  ['`vh`', false],
                ],
              },
            ],
          },
          {
            type: 'assignment',
            title: 'Build a personal landing page',
            due: -2,
            points: 100,
            description: `Create a one-page personal site using **semantic HTML** and **CSS Grid or Flexbox**.

**Requirements**

- A header with your name and a short tagline
- An "About" section and a "Projects" section with at least three cards
- A layout that works on phones and desktops
- No CSS frameworks: write the CSS yourself

Submit a link to your published page (GitHub Pages or Netlify are free) and a short note on what you found hardest.`,
          },
        ],
      },
      {
        title: 'JavaScript Essentials',
        summary: 'Values, functions, the DOM and events.',
        activities: [
          {
            type: 'lesson',
            title: 'Variables, types and functions',
            minutes: 14,
            body: `# Variables, types and functions

\`\`\`js
const course = 'Modern Web Development'; // can't be reassigned
let lessonsDone = 3;                     // can change
lessonsDone += 1;

function greet(name) {
  return \`Hello, \${name}!\`;
}

const double = (n) => n * 2;
\`\`\`

## The seven primitive types

\`string\`, \`number\`, \`bigint\`, \`boolean\`, \`undefined\`, \`symbol\` and \`null\`. Everything else is an **object**, including arrays and functions.

> Prefer \`const\` by default and reach for \`let\` only when a value really needs to change.`,
          },
          {
            type: 'lesson',
            title: 'Working with the DOM',
            minutes: 12,
            body: `# Working with the DOM

The Document Object Model is the browser's live, tree-shaped representation of your page.

\`\`\`js
const button = document.querySelector('#add');
const list = document.querySelector('#todos');

button.addEventListener('click', () => {
  const item = document.createElement('li');
  item.textContent = 'A new task';
  list.append(item);
});
\`\`\`

## Tips

- Use \`textContent\` (not \`innerHTML\`) for user-provided text to avoid XSS.
- Delegate events to a parent element when you have many similar children.`,
          },
          {
            type: 'resource',
            title: 'MDN JavaScript Guide',
            url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide',
            description: 'A thorough, free guide to the language.',
          },
          {
            type: 'quiz',
            title: 'JavaScript fundamentals',
            due: 4,
            timeLimit: 15,
            attempts: 2,
            description: 'Fifteen minutes, six questions. Make sure you have finished the two JavaScript lessons first.',
            questions: [
              {
                type: 'single',
                prompt: 'What does `typeof null` return?',
                options: [
                  ['`"object"`', true],
                  ['`"null"`', false],
                  ['`"undefined"`', false],
                  ['`"number"`', false],
                ],
                explanation: 'A famous quirk from the first version of JavaScript that can never be fixed.',
              },
              {
                type: 'truefalse',
                prompt: '`const` prevents the properties of an object from being changed.',
                options: [
                  ['True', false],
                  ['False', true],
                ],
                explanation: '`const` only prevents reassignment of the variable. Use `Object.freeze` to freeze an object.',
              },
              {
                type: 'multiple',
                prompt: 'Which array methods return a new array without changing the original?',
                options: [
                  ['`map`', true],
                  ['`filter`', true],
                  ['`push`', false],
                  ['`slice`', true],
                  ['`splice`', false],
                ],
              },
              {
                type: 'short',
                prompt: 'Which array method calls a function once for each element and always returns `undefined`?',
                accepted: ['forEach', 'forEach()', 'array.forEach'],
              },
              {
                type: 'numeric',
                prompt: 'What is the value of `[1, 2, 3].reduce((sum, n) => sum + n, 10)`?',
                accepted: ['16'],
              },
              {
                type: 'single',
                prompt: 'Which statement about `===` is true?',
                options: [
                  ['It compares values without type conversion', true],
                  ['It converts both values to strings first', false],
                  ['It only works with numbers', false],
                ],
              },
            ],
          },
          {
            type: 'assignment',
            title: 'Interactive to-do list',
            due: 6,
            points: 100,
            description: `Build a to-do list in plain JavaScript.

- Add, complete and delete tasks
- Persist tasks in \`localStorage\`
- Keyboard accessible: everything works without a mouse

Upload a zip of your project or paste a link to the repository.`,
          },
        ],
      },
      {
        title: 'Building with React',
        summary: 'Components, state and effects, then your final project.',
        activities: [
          {
            type: 'lesson',
            title: 'Thinking in components',
            minutes: 10,
            body: `# Thinking in components

React apps are trees of small, reusable **components**. Each one takes props and returns UI.

\`\`\`jsx
function CourseCard({ title, progress }) {
  return (
    <article className="card">
      <h3>{title}</h3>
      <progress value={progress} max={100} />
    </article>
  );
}
\`\`\`

Start from a mock-up, draw boxes around each piece of UI, and name them. Those boxes are your components.`,
          },
          {
            type: 'lesson',
            title: 'State and effects',
            minutes: 15,
            body: `# State and effects

\`\`\`jsx
function Timer() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return <p>{seconds}s on this lesson</p>;
}
\`\`\`

- **State** is data that changes over time and should re-render the UI.
- **Effects** synchronise your component with something outside React.`,
          },
          {
            type: 'assignment',
            title: 'Final project: ship a React app',
            due: 40,
            points: 200,
            description:
              'Design and build a small React application of your choice, deploy it, and write a short README explaining your decisions. Details and the marking rubric are in the announcement.',
          },
          {
            type: 'forum',
            title: 'Project showcase',
            description: 'Share what you are building and give each other feedback.',
            studentsStart: true,
          },
        ],
      },
    ],
  },
  {
    slug: 'data-science-fundamentals',
    title: 'Data Science Fundamentals',
    category: 'Data & AI',
    cover: 'emerald',
    summary: 'Learn to explore, analyse and visualise data with statistics and Python.',
    description: `## About this course

A practical introduction to data science for complete beginners. You'll learn just enough statistics to reason about data, then put it into practice with Python, pandas and charts.

### You will be able to

- Summarise a dataset with the right descriptive statistics
- Load, clean and explore data with pandas
- Choose a chart that answers your question honestly`,
    teacher: 'daniel',
    start: -21,
    end: 70,
    sections: [
      {
        title: 'Getting started',
        activities: [
          {
            type: 'lesson',
            title: 'What is data science?',
            minutes: 6,
            body: `# What is data science?

Data science is the practice of **asking good questions** and answering them with data. It sits where statistics, programming and domain knowledge meet.

A typical project loops through five steps: *question → collect → clean → explore → communicate*. Most of the time goes into cleaning!`,
          },
          { type: 'forum', title: 'Q&A', description: 'Ask anything about the course material.', studentsStart: true },
        ],
      },
      {
        title: 'Statistics refresher',
        activities: [
          {
            type: 'lesson',
            title: 'Descriptive statistics',
            minutes: 12,
            body: `# Descriptive statistics

| Measure | Describes | Sensitive to outliers? |
| --- | --- | --- |
| Mean | centre | yes |
| Median | centre | no |
| Standard deviation | spread | yes |
| Interquartile range | spread | no |

When a distribution is skewed (incomes, house prices), the **median** usually tells the more honest story.`,
          },
          {
            type: 'lesson',
            title: 'Probability basics',
            minutes: 10,
            body: `# Probability basics

A probability is a number between 0 and 1. For independent events, multiply: the chance of two heads in a row is \`0.5 × 0.5 = 0.25\`.`,
          },
          {
            type: 'quiz',
            title: 'Statistics quiz',
            due: 2,
            description: 'Four questions on descriptive statistics. Unlimited attempts.',
            questions: [
              {
                type: 'single',
                prompt: 'Which measure of central tendency is most robust to outliers?',
                options: [
                  ['Median', true],
                  ['Mean', false],
                  ['Range', false],
                  ['Variance', false],
                ],
              },
              { type: 'numeric', prompt: 'What is the mean of 2, 4, 6, 8 and 10?', accepted: ['6'] },
              {
                type: 'truefalse',
                prompt: 'A correlation of −0.9 indicates a weak relationship.',
                options: [
                  ['True', false],
                  ['False', true],
                ],
                explanation: 'The sign gives the direction; the magnitude (0.9) shows a strong relationship.',
              },
              {
                type: 'multiple',
                prompt: 'Which of these are measures of spread?',
                options: [
                  ['Standard deviation', true],
                  ['Interquartile range', true],
                  ['Mode', false],
                  ['Variance', true],
                ],
              },
            ],
          },
        ],
      },
      {
        title: 'Python for data',
        activities: [
          {
            type: 'lesson',
            title: 'NumPy and pandas in 20 minutes',
            minutes: 20,
            body: `# NumPy and pandas in 20 minutes

\`\`\`python
import pandas as pd

df = pd.read_csv("students.csv")
df.head()
df.describe()
df.groupby("course")["grade"].mean().sort_values()
\`\`\`

pandas gives you **DataFrames**: tables with labelled rows and columns and hundreds of tools for slicing them.`,
          },
          {
            type: 'assignment',
            title: 'Exploratory analysis of a dataset',
            due: 9,
            points: 50,
            description:
              'Pick a public dataset, ask three questions about it and answer them with pandas. Upload your notebook and a one-paragraph summary.',
          },
        ],
      },
      {
        title: 'Visualization',
        activities: [
          {
            type: 'lesson',
            title: 'Choosing the right chart',
            minutes: 9,
            body: `# Choosing the right chart

- **Compare categories** → bar chart
- **Show change over time** → line chart
- **Show a distribution** → histogram or box plot
- **Show a relationship** → scatter plot`,
          },
        ],
      },
    ],
  },
  {
    slug: 'ux-design-principles',
    title: 'UX Design Principles',
    category: 'Design',
    cover: 'rose',
    summary: 'Design products people love: usability heuristics, research and prototyping.',
    description: `## About this course

Good design is invisible. In this course you'll learn the principles behind usable products, practise talking to users and turn insights into prototypes.`,
    teacher: 'maya',
    start: -10,
    end: 50,
    sections: [
      {
        title: 'Foundations',
        activities: [
          {
            type: 'lesson',
            title: 'What makes a design usable?',
            minutes: 8,
            body: `# What makes a design usable?

Jakob Nielsen's ten usability heuristics are still the best checklist around. Three to start with:

1. **Visibility of system status**: always keep people informed.
2. **Match between the system and the real world**: speak the user's language.
3. **Consistency and standards**: don't make people wonder whether different words mean the same thing.`,
          },
          {
            type: 'lesson',
            title: 'Visual hierarchy',
            minutes: 10,
            body: `# Visual hierarchy

Size, contrast, colour, spacing and position tell people what to look at first. Squint at your design: the elements you can still make out are the ones your hierarchy emphasises.`,
          },
          {
            type: 'quiz',
            title: 'Design principles quiz',
            due: 12,
            description: 'Three questions on usability fundamentals.',
            questions: [
              {
                type: 'single',
                prompt: 'Which heuristic says people should not have to wonder whether different words or actions mean the same thing?',
                options: [
                  ['Consistency and standards', true],
                  ['Error prevention', false],
                  ['Aesthetic and minimalist design', false],
                  ['Recognition rather than recall', false],
                ],
              },
              {
                type: 'truefalse',
                prompt: 'Testing with about five users typically uncovers most of the usability problems in a design.',
                options: [
                  ['True', true],
                  ['False', false],
                ],
              },
              {
                type: 'short',
                prompt: 'Which law says the time to reach a target depends on its distance and size?',
                accepted: ["fitts's law", 'fitts law', "fitts' law", 'fitts'],
              },
            ],
          },
        ],
      },
      {
        title: 'Research',
        activities: [
          {
            type: 'lesson',
            title: 'Interviewing users',
            minutes: 12,
            body: `# Interviewing users

Ask about **past behaviour**, not hypothetical futures. "Tell me about the last time you…" beats "Would you use…?" every time.`,
          },
          {
            type: 'assignment',
            title: 'Usability test report',
            due: 15,
            points: 100,
            description:
              'Run a usability test with three people on an app you use every day. Report your top five findings with evidence and a recommendation for each.',
          },
        ],
      },
      {
        title: 'Prototyping',
        activities: [
          {
            type: 'lesson',
            title: 'From sketches to prototypes',
            minutes: 9,
            body: '# From sketches to prototypes\n\nStart on paper. Move to a clickable prototype only once the flow makes sense. Fidelity should rise with confidence.',
          },
          {
            type: 'forum',
            title: 'Critique corner',
            description: 'Share work in progress and get constructive feedback.',
            studentsStart: true,
          },
        ],
      },
    ],
  },
  {
    slug: 'product-management-101',
    title: 'Product Management 101',
    category: 'Business',
    cover: 'amber',
    summary: 'Discover problems worth solving, prioritise ruthlessly and ship with confidence.',
    description:
      '## About this course\n\nA practical introduction to the product manager role, from discovery to delivery.\n\nThis course uses an **enrolment key**. Try `launch`.',
    teacher: 'daniel',
    enrolment: 'key',
    key: 'launch',
    start: -5,
    end: 45,
    sections: [
      {
        title: 'The PM role',
        activities: [
          {
            type: 'lesson',
            title: 'What product managers actually do',
            minutes: 7,
            body: '# What product managers actually do\n\nProduct managers own the **why** and the **what**; engineering and design own the **how**. Your job is to make sure the team is always working on the most valuable problem.',
          },
        ],
      },
      {
        title: 'Discovery',
        activities: [
          {
            type: 'lesson',
            title: 'Finding problems worth solving',
            minutes: 11,
            body: '# Finding problems worth solving\n\nA good problem is **frequent**, **painful** and **valuable** to solve. Talk to customers before you write a single line of a spec.',
          },
          {
            type: 'assignment',
            title: 'Write a problem statement',
            due: 8,
            points: 20,
            types: ['text'],
            description:
              'Write a one-page problem statement for a product you use: who has the problem, how often, what it costs them, and how you would measure success.',
          },
        ],
      },
    ],
  },
  {
    slug: 'spanish-for-beginners',
    title: 'Spanish for Beginners',
    category: 'Languages',
    cover: 'sunset',
    summary: 'Start speaking Spanish from day one with everyday phrases and conversation practice.',
    description:
      '## ¡Bienvenidos!\n\nLearn the essentials of Spanish through short lessons, vocabulary quizzes and practice with classmates.',
    teacher: 'daniel',
    start: -14,
    end: 56,
    sections: [
      {
        title: 'Unidad 1: Saludos',
        summary: 'Greetings and introductions.',
        activities: [
          {
            type: 'lesson',
            title: 'Greetings and introductions',
            minutes: 8,
            body: `# Greetings and introductions

| Spanish | English |
| --- | --- |
| Hola | Hello |
| Buenos días | Good morning |
| Me llamo… | My name is… |
| ¿Cómo estás? | How are you? |
| Hasta luego | See you later |`,
          },
          {
            type: 'quiz',
            title: 'Vocabulary check',
            description: 'Type the Spanish words. Accents are optional for now.',
            questions: [
              { type: 'short', prompt: 'Translate to Spanish: **Good morning**', accepted: ['buenos días', 'buenos dias'] },
              { type: 'short', prompt: 'Translate to Spanish: **Thank you**', accepted: ['gracias'] },
              {
                type: 'single',
                prompt: 'How do you say "My name is Ana"?',
                options: [
                  ['Me llamo Ana', true],
                  ['Yo llamo Ana', false],
                  ['Mi nombre Ana', false],
                  ['Soy llamo Ana', false],
                ],
              },
              {
                type: 'truefalse',
                prompt: '"Hasta luego" means "See you later".',
                options: [
                  ['True', true],
                  ['False', false],
                ],
              },
            ],
          },
          {
            type: 'forum',
            title: 'Practice partners',
            description: 'Find a classmate to practise conversation with.',
            studentsStart: true,
          },
        ],
      },
    ],
  },
  {
    slug: 'machine-learning-in-practice',
    title: 'Machine Learning in Practice',
    category: 'Data & AI',
    cover: 'fuchsia',
    summary: 'Train, evaluate and deploy real machine learning models. Coming soon.',
    description: '## Coming soon\n\nThis course is still being written. Only teachers can see it while it is a draft.',
    teacher: 'daniel',
    visibility: 'draft',
    start: 30,
    end: 120,
    sections: [
      {
        title: 'Course overview',
        activities: [
          {
            type: 'lesson',
            title: 'Syllabus (draft)',
            minutes: 5,
            body: '# Syllabus (draft)\n\n1. Framing a machine learning problem\n2. Baselines and evaluation\n3. Feature engineering\n4. Deploying and monitoring models',
          },
        ],
      },
    ],
  },
];

/** Which students take which course (the main demo student, Alex, is in four). */
const ROSTER: Record<string, Person[]> = {
  'modern-web-development': ['alex', 'sofia', 'liam', 'emma', 'noah', 'olivia', 'ethan', 'ava', 'lucas', 'mia', 'james', 'zara'],
  'data-science-fundamentals': ['alex', 'emma', 'noah', 'ethan', 'mia', 'zara', 'james'],
  'ux-design-principles': ['alex', 'sofia', 'olivia', 'ava', 'priya', 'lucas'],
  'product-management-101': ['liam', 'noah', 'ava', 'james'],
  'spanish-for-beginners': ['alex', 'sofia', 'mia', 'lucas', 'emma'],
  'machine-learning-in-practice': [],
};

const FEEDBACK = [
  'Great structure and really clean CSS. Next time, check the colour contrast of your buttons.',
  'Solid work! Your Grid layout is spot on. Consider adding alt text to the project images.',
  'Nice job. The mobile layout breaks slightly below 360px; try `minmax()` on the cards.',
  'Excellent, one of the best submissions this term. Clear, semantic and accessible.',
  'Good start. Please split the page into semantic sections rather than nested divs.',
];

async function insertChunks<T extends keyof Database>(db: AppDeps['db'], table: T, rows: Insertable<Database[T]>[], size = 100) {
  for (let i = 0; i < rows.length; i += size) {
    await db
      .insertInto(table)
      .values(rows.slice(i, i + size) as never)
      .execute();
  }
}

export async function seedDemo(deps: Pick<AppDeps, 'db' | 'events'>, options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const { db } = deps;
  const rand = mulberry32(20261124);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;

  const exists = await db.selectFrom('courses').select('id').where('slug', '=', COURSES[0]!.slug).executeTakeFirst();
  if (exists) return { created: false, password: null, users: [], courses: 0 };

  const password = options.password ?? randomToken(12);
  const passwordHash = await hashPassword(password);
  const ts = new Date().toISOString();

  // People
  let admin =
    options.admin ?? (await db.selectFrom('users').selectAll().where('role', '=', 'admin').orderBy('createdAt').executeTakeFirst());
  const users: SeedDemoResult['users'] = [];
  if (!admin) {
    admin = {
      id: newId(),
      email: 'admin@coursekit.test',
      name: 'Ada Admin',
      passwordHash,
      role: 'admin',
      avatarUrl: null,
      bio: 'Site administrator.',
      status: 'active',
      lastLoginAt: null,
      createdAt: at(-45),
      updatedAt: ts,
    };
    await db.insertInto('users').values(admin).execute();
    users.push({ name: admin.name, email: admin.email, role: 'admin' });
  }

  const ids = {} as Record<Person, string>;
  const existingEmails = new Set(
    (
      await db
        .selectFrom('users')
        .select('email')
        .where(
          'email',
          'in',
          Object.values(PEOPLE).map((p) => p.email),
        )
        .execute()
    ).map((u) => u.email),
  );
  const userRows = [];
  for (const [key, p] of Object.entries(PEOPLE) as Array<[Person, (typeof PEOPLE)[Person]]>) {
    if (existingEmails.has(p.email)) {
      const row = await db.selectFrom('users').select('id').where('email', '=', p.email).executeTakeFirstOrThrow();
      ids[key] = row.id;
      continue;
    }
    ids[key] = newId();
    userRows.push({
      id: ids[key],
      email: p.email,
      name: p.name,
      passwordHash,
      role: p.role,
      avatarUrl: null,
      bio: 'bio' in p ? p.bio : null,
      status: 'active' as const,
      lastLoginAt: at(-Math.floor(rand() * 3)),
      createdAt: at(-40 + Math.floor(rand() * 35)),
      updatedAt: ts,
    });
    users.push({ name: p.name, email: p.email, role: p.role });
  }
  await insertChunks(db, 'users', userRows);

  // Categories
  const categoryIds = new Map<string, string>();
  for (const [index, [name, description]] of CATEGORIES.entries()) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const existing = await db.selectFrom('categories').select('id').where('slug', '=', slug).executeTakeFirst();
    if (existing) {
      categoryIds.set(name, existing.id);
      continue;
    }
    const id = newId();
    categoryIds.set(name, id);
    await db.insertInto('categories').values({ id, name, slug, description, sortOrder: index, createdAt: ts }).execute();
  }

  const courses: Insertable<CoursesTable>[] = [];
  const enrolments: Insertable<EnrolmentsTable>[] = [];
  const sections: Insertable<SectionsTable>[] = [];
  const activities: Insertable<ActivitiesTable>[] = [];
  const questions: Insertable<QuestionsTable>[] = [];
  const completions: Insertable<CompletionsTable>[] = [];
  const submissions: Insertable<SubmissionsTable>[] = [];
  const grades: Insertable<GradesTable>[] = [];
  const attempts: Insertable<QuizAttemptsTable>[] = [];
  const discussions: Insertable<DiscussionsTable>[] = [];
  const posts: Insertable<PostsTable>[] = [];
  const announcements: Insertable<AnnouncementsTable>[] = [];
  const notifications: Insertable<NotificationsTable>[] = [];
  const events: Insertable<CalendarEventsTable>[] = [];

  const activityIndex = new Map<
    string,
    { id: string; courseId: string; slug: string; type: ActivityType; due: string | null; maxGrade: number | null }
  >();

  for (const spec of COURSES) {
    const courseId = newId();
    courses.push({
      id: courseId,
      slug: spec.slug,
      title: spec.title,
      summary: spec.summary,
      description: spec.description,
      categoryId: categoryIds.get(spec.category) ?? null,
      coverColor: spec.cover,
      coverImageUrl: null,
      visibility: spec.visibility ?? 'published',
      enrolment: spec.enrolment ?? 'open',
      enrolmentKey: spec.key ?? null,
      startDate: at(spec.start, 0),
      endDate: at(spec.end, 0),
      createdBy: ids[spec.teacher as Person],
      createdAt: at(spec.start - 10),
      updatedAt: ts,
    });

    const enrol = (person: Person, role: CourseRole, daysAgo: number) =>
      enrolments.push({
        id: newId(),
        courseId,
        userId: ids[person],
        role,
        status: 'active',
        lastAccessAt: at(-rand() * 4, 8 + Math.floor(rand() * 10)),
        createdAt: at(-daysAgo),
      });
    enrol(spec.teacher as Person, 'teacher', -spec.start + 10);
    if (spec.assistant) enrol(spec.assistant as Person, 'assistant', -spec.start + 5);
    const students = ROSTER[spec.slug] ?? [];
    for (const s of students) enrol(s, 'student', Math.max(1, -spec.start - Math.floor(rand() * 5)));

    const courseActivities: string[] = [];
    for (const [sIndex, sec] of spec.sections.entries()) {
      const sectionId = newId();
      sections.push({ id: sectionId, courseId, title: sec.title, summary: sec.summary ?? '', position: sIndex, visible: 1, createdAt: ts });

      for (const [aIndex, a] of sec.activities.entries()) {
        const id = newId();
        let settings: ActivitySettingsMap[ActivityType];
        let completion: 'none' | 'manual' | 'auto' = 'auto';
        let dueAt: string | null = null;
        let maxGrade: number | null = null;
        let description = 'description' in a && a.description ? a.description : '';

        switch (a.type) {
          case 'lesson':
            settings = { body: a.body, videoUrl: null, estimatedMinutes: a.minutes };
            completion = a.completion ?? 'manual';
            break;
          case 'resource':
            settings = { kind: 'link', fileId: null, url: a.url };
            break;
          case 'assignment':
            settings = { submissionTypes: a.types ?? ['text', 'file'], allowLate: true, maxFiles: 5 };
            dueAt = at(a.due, 17, 0);
            maxGrade = a.points ?? 100;
            description = a.description;
            break;
          case 'quiz': {
            settings = {
              timeLimitMinutes: a.timeLimit ?? null,
              attemptsAllowed: a.attempts ?? 0,
              gradingMethod: 'highest',
              shuffleQuestions: false,
              reviewMode: 'immediate',
              passingPercent: null,
            };
            dueAt = a.due != null ? at(a.due, 17, 0) : null;
            let total = 0;
            for (const [qIndex, q] of a.questions.entries()) {
              const points = q.points ?? (q.type === 'multiple' ? 2 : 1);
              total += points;
              questions.push({
                id: newId(),
                activityId: id,
                type: q.type,
                prompt: q.prompt,
                points,
                options: JSON.stringify((q.options ?? []).map(([text, correct]) => ({ id: newId(8), text, correct }))),
                acceptedAnswers: JSON.stringify(q.accepted ?? []),
                tolerance: q.tolerance ?? null,
                explanation: q.explanation ?? null,
                position: qIndex,
              });
            }
            maxGrade = total;
            break;
          }
          case 'forum':
            settings = { studentsCanStartDiscussions: a.studentsStart ?? true };
            completion = 'auto';
            break;
        }

        activities.push({
          id,
          courseId,
          sectionId,
          type: a.type,
          title: a.title,
          description,
          position: aIndex,
          visible: 1,
          settings: JSON.stringify(settings),
          dueAt,
          maxGrade,
          completion,
          createdBy: ids[spec.teacher as Person],
          createdAt: at(spec.start - 5 + sIndex * 7),
          updatedAt: ts,
        });
        activityIndex.set(`${spec.slug}/${a.title}`, { id, courseId, slug: spec.slug, type: a.type, due: dueAt, maxGrade });
        courseActivities.push(id);
      }
    }

    // Completion: each student has worked through a different share of the course.
    if (spec.visibility !== 'draft') {
      for (const s of students) {
        const share = s === 'alex' ? 0.55 : 0.15 + rand() * 0.7;
        const count = Math.floor(courseActivities.length * share);
        for (const activityId of courseActivities.slice(0, count)) {
          const act = activities.find((x) => x.id === activityId)!;
          // Graded work and forums are completed by submissions, attempts and posts below.
          if (act.completion === 'none' || (act.type !== 'lesson' && act.type !== 'resource')) continue;
          completions.push({
            activityId,
            userId: ids[s],
            courseId,
            completedAt: at(-Math.floor(rand() * 14), 10 + Math.floor(rand() * 8)),
          });
        }
      }
    }
  }

  // Quiz attempts (finished) for past/closing quizzes.
  const questionRows = (activityId: string) => questions.filter((q) => q.activityId === activityId);
  const attemptQuiz = (key: string, people: Person[], skill: (p: Person) => number) => {
    const quiz = activityIndex.get(key)!;
    for (const p of people) {
      const qs = questionRows(quiz.id);
      const answers: Record<string, AttemptAnswer> = {};
      for (const q of qs) {
        const options = JSON.parse(q.options as string) as Array<{ id: string; text: string; correct: boolean }>;
        const right = rand() < skill(p);
        if (q.type === 'short' || q.type === 'numeric') {
          const accepted = JSON.parse(q.acceptedAnswers as string) as string[];
          answers[q.id!] = { text: right ? accepted[0] : 'not sure' };
        } else if (q.type === 'multiple') {
          answers[q.id!] = { optionIds: options.filter((o) => (right ? o.correct : rand() < 0.5)).map((o) => o.id) };
        } else {
          const choice = right ? options.find((o) => o.correct) : options.find((o) => !o.correct);
          answers[q.id!] = { optionIds: choice ? [choice.id] : [] };
        }
      }
      const results: Record<string, ReturnType<typeof gradeQuestion>> = {};
      let score = 0;
      let max = 0;
      for (const q of qs) {
        const r = gradeQuestion(q as never, answers[q.id!]);
        results[q.id!] = r;
        score += r.points;
        max += r.maxPoints;
      }
      const started = at(-4 - Math.floor(rand() * 6), 9 + Math.floor(rand() * 9), Math.floor(rand() * 59));
      const finished = new Date(Date.parse(started) + (6 + rand() * 12) * 60_000).toISOString();
      attempts.push({
        id: newId(),
        activityId: quiz.id,
        courseId: quiz.courseId,
        userId: ids[p],
        attemptNumber: 1,
        status: 'finished',
        questionOrder: JSON.stringify(qs.map((q) => q.id)),
        answers: JSON.stringify(answers),
        results: JSON.stringify(results),
        score: round(score),
        maxScore: round(max),
        startedAt: started,
        deadlineAt: null,
        finishedAt: finished,
      });
      grades.push({
        activityId: quiz.id,
        userId: ids[p],
        courseId: quiz.courseId,
        score: round(max > 0 ? (score / max) * (quiz.maxGrade ?? max) : 0),
        feedback: null,
        gradedBy: null,
        gradedAt: finished,
        updatedAt: finished,
      });
      if (!completions.some((c) => c.activityId === quiz.id && c.userId === ids[p])) {
        completions.push({ activityId: quiz.id, userId: ids[p], courseId: quiz.courseId, completedAt: finished });
      }
    }
  };
  const skill = (p: Person) => (p === 'alex' ? 0.85 : 0.55 + rand() * 0.4);
  attemptQuiz(
    'modern-web-development/HTML & CSS check-in',
    ['alex', 'sofia', 'liam', 'emma', 'noah', 'olivia', 'ethan', 'ava', 'mia', 'zara'],
    skill,
  );
  attemptQuiz('spanish-for-beginners/Vocabulary check', ['sofia', 'mia', 'lucas'], skill);
  attemptQuiz('data-science-fundamentals/Statistics quiz', ['emma', 'noah', 'zara'], skill);

  // Assignment submissions.
  const submit = (key: string, people: Person[], gradeThem: boolean, text: (first: string) => string) => {
    const a = activityIndex.get(key)!;
    for (const p of people) {
      const daysBeforeDue = 0.2 + rand() * 4;
      const submittedAt = new Date(
        Math.min(Date.now() - (1 + rand() * 40) * 3_600_000, Date.parse(a.due!) - daysBeforeDue * DAY),
      ).toISOString();
      const first = PEOPLE[p].name.split(' ')[0]!.toLowerCase();
      submissions.push({
        id: newId(),
        activityId: a.id,
        courseId: a.courseId,
        userId: ids[p],
        text: text(first),
        fileIds: '[]',
        submittedAt,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      });
      if (!completions.some((c) => c.activityId === a.id && c.userId === ids[p])) {
        completions.push({ activityId: a.id, userId: ids[p], courseId: a.courseId, completedAt: submittedAt });
      }
      if (gradeThem) {
        const max = a.maxGrade ?? 100;
        const score = p === 'alex' ? round(max * 0.92) : round(max * (0.68 + rand() * 0.3));
        const gradedAt = new Date(Date.parse(submittedAt) + (1 + rand()) * DAY).toISOString();
        grades.push({
          activityId: a.id,
          userId: ids[p],
          courseId: a.courseId,
          score,
          feedback: p === 'alex' ? FEEDBACK[0]! : pick(FEEDBACK),
          gradedBy: ids.maya,
          gradedAt: gradedAt > ts ? ts : gradedAt,
          updatedAt: gradedAt > ts ? ts : gradedAt,
        });
      }
    }
  };
  submit(
    'modern-web-development/Build a personal landing page',
    ['alex', 'sofia', 'liam', 'emma', 'noah', 'olivia', 'ethan', 'ava', 'mia', 'zara'],
    true,
    (first) =>
      `My page is live at https://${first}.example.dev\n\nThe hardest part was making the layout responsive. I used CSS Grid with \`auto-fill\` and \`minmax()\` for the project cards.`,
  );
  submit(
    'modern-web-development/Interactive to-do list',
    ['sofia', 'emma', 'noah', 'zara'],
    false,
    (first) =>
      `Repository: https://git.example.dev/${first}/todo\n\nTasks persist in localStorage and everything works with the keyboard (Enter to add, Space to toggle).`,
  );
  submit(
    'data-science-fundamentals/Exploratory analysis of a dataset',
    ['emma', 'zara'],
    false,
    () => 'I analysed city bike-share trips. Weekend rides are 40% longer on average, and usage peaks at 8am and 6pm on weekdays.',
  );
  submit(
    'ux-design-principles/Usability test report',
    ['olivia'],
    false,
    () =>
      'I tested a food-delivery app with three people. Top finding: nobody found the promo-code field because it hides behind a collapsed accordion.',
  );

  // Forum threads.
  const thread = (key: string, author: Person, title: string, body: string, daysAgo: number, replies: Array<[Person, string]>) => {
    const forum = activityIndex.get(key)!;
    const discussionId = newId();
    const created = at(-daysAgo, 9 + Math.floor(rand() * 8), Math.floor(rand() * 59));
    const rootId = newId();
    posts.push({
      id: rootId,
      discussionId,
      courseId: forum.courseId,
      userId: ids[author],
      parentId: null,
      body,
      createdAt: created,
      updatedAt: created,
    });
    let last = created;
    for (const [person, text] of replies) {
      // Each reply lands a few hours after the previous one.
      last = new Date(Date.parse(last) + (2 + rand() * 10) * 3_600_000).toISOString();
      if (last > ts) last = ts;
      posts.push({
        id: newId(),
        discussionId,
        courseId: forum.courseId,
        userId: ids[person],
        parentId: rootId,
        body: text,
        createdAt: last,
        updatedAt: last,
      });
    }
    discussions.push({
      id: discussionId,
      activityId: forum.id,
      courseId: forum.courseId,
      userId: ids[author],
      title,
      pinned: 0,
      locked: 0,
      replyCount: replies.length,
      lastPostAt: last,
      createdAt: created,
    });
    return discussionId;
  };

  const lisbon = thread(
    'modern-web-development/Introductions',
    'sofia',
    'Hi from Lisbon! 👋',
    "Hi everyone! I'm Sofia, a graphic designer from Lisbon. I want to learn to build the sites I design instead of handing them off. Excited to be here!",
    26,
    [
      ['maya', 'Welcome, Sofia! Designers make fantastic front-end developers. You already have the eye for detail. 🎨'],
      ['alex', "Hey Sofia! I'm also switching careers. Want to pair on the landing page assignment?"],
      ['sofia', "@Alex absolutely, let's do it!"],
    ],
  );
  thread(
    'modern-web-development/Introductions',
    'alex',
    'Career switcher, ex-accountant',
    "Hello! I'm Alex. After eight years in accounting I decided it's time to build things. Goal: get a junior front-end role by next summer.",
    25,
    [
      ['priya', "Love it, Alex. Spreadsheets are basically programming, so you're further along than you think!"],
      ['liam', 'Same boat here (from teaching). Good luck!'],
    ],
  );
  thread(
    'modern-web-development/Introductions',
    'noah',
    'Noah from Seoul',
    'Hi all, backend Java developer here, finally learning the front end properly. 😅',
    24,
    [['emma', 'Welcome Noah! You can help us with the JavaScript bits then.']],
  );
  thread(
    'modern-web-development/Project showcase',
    'zara',
    'My portfolio built with CSS Grid',
    'Here is my landing page: https://zara.example.dev. Feedback on the colour palette very welcome!',
    3,
    [
      ['maya', 'Lovely use of grid areas, Zara. Try bumping the body text contrast a little.'],
      ['olivia', 'The hover animations are so smooth!'],
    ],
  );
  thread(
    'data-science-fundamentals/Q&A',
    'mia',
    'How much Python do I need before starting?',
    'I have only done a little Python before. Is that enough for this course?',
    12,
    [
      ['daniel', "Absolutely. We start from the basics in the Python section. If you can write a for-loop you're ready."],
      ['ethan', 'I found the official Python tutorial helpful as a warm-up.'],
    ],
  );
  thread(
    'ux-design-principles/Critique corner',
    'olivia',
    'Onboarding flow for a plant-care app 🌱',
    'Three screens of onboarding. Is it too long?',
    2,
    [['maya', 'Could the second screen be optional? Let people skip straight to adding their first plant.']],
  );

  // Announcements.
  const announce = (slug: string, author: Person, title: string, body: string, daysAgo: number) => {
    const course = courses.find((c) => c.slug === slug)!;
    announcements.push({ id: newId(), courseId: course.id, userId: ids[author], title, body, createdAt: at(-daysAgo, 8, 30) });
  };
  announce(
    'modern-web-development',
    'maya',
    'Welcome to Modern Web Development!',
    "Welcome everyone! Start with the **Welcome** section and introduce yourself in the forum. I'll host a live Q&A every Thursday.",
    29,
  );
  announce(
    'modern-web-development',
    'maya',
    'Live Q&A this Thursday',
    "This week's Q&A focuses on the **JavaScript fundamentals** quiz and the to-do list assignment. Bring your questions! The link is in the calendar.",
    1,
  );
  announce(
    'data-science-fundamentals',
    'daniel',
    'Office hours moved to Friday',
    'This week only, office hours move to **Friday at 4pm UTC**.',
    3,
  );
  announce(
    'ux-design-principles',
    'maya',
    'Guest speaker next week',
    'A senior researcher will join us to talk about running interviews. Prepare one question each!',
    2,
  );

  // Calendar events.
  const webDev = courses.find((c) => c.slug === 'modern-web-development')!;
  const dataSci = courses.find((c) => c.slug === 'data-science-fundamentals')!;
  events.push(
    {
      id: newId(),
      courseId: webDev.id,
      userId: null,
      title: 'Live Q&A session',
      description: 'Weekly live Q&A with Maya.',
      startsAt: at(2, 17),
      endsAt: at(2, 18),
      createdBy: ids.maya,
      createdAt: ts,
    },
    {
      id: newId(),
      courseId: dataSci.id,
      userId: null,
      title: 'Office hours',
      description: 'Drop in with any question about the course.',
      startsAt: at(4, 16),
      endsAt: at(4, 17),
      createdBy: ids.daniel,
      createdAt: ts,
    },
  );

  // A few notifications so the demo student's bell isn't empty.
  const landing = activityIndex.get('modern-web-development/Build a personal landing page')!;
  notifications.push(
    {
      id: newId(),
      userId: ids.alex,
      type: 'announcement',
      title: 'Modern Web Development: Live Q&A this Thursday',
      body: "This week's Q&A focuses on the JavaScript fundamentals quiz and the to-do list assignment.",
      link: '/courses/modern-web-development/announcements',
      readAt: null,
      createdAt: at(-1, 8, 30),
    },
    {
      id: newId(),
      userId: ids.alex,
      type: 'grade',
      title: 'Build a personal landing page was graded',
      body: 'You received 92 / 100. Your teacher left feedback.',
      link: `/courses/modern-web-development/activities/${landing.id}`,
      readAt: null,
      createdAt: at(-1, 14),
    },
    {
      id: newId(),
      userId: ids.alex,
      type: 'forum',
      title: 'Sofia Martinez replied in “Hi from Lisbon! 👋”',
      body: "@Alex absolutely, let's do it!",
      link: `/courses/modern-web-development/discussions/${lisbon}`,
      readAt: at(-20),
      createdAt: at(-24),
    },
  );

  await insertChunks(db, 'courses', courses);
  await insertChunks(db, 'enrolments', enrolments);
  await insertChunks(db, 'sections', sections);
  await insertChunks(db, 'activities', activities);
  await insertChunks(db, 'questions', questions);
  await insertChunks(db, 'completions', completions);
  await insertChunks(db, 'submissions', submissions);
  await insertChunks(db, 'grades', grades);
  await insertChunks(db, 'quizAttempts', attempts);
  await insertChunks(db, 'discussions', discussions);
  await insertChunks(db, 'posts', posts);
  await insertChunks(db, 'announcements', announcements);
  await insertChunks(db, 'calendarEvents', events);
  await insertChunks(db, 'notifications', notifications);

  return { created: true, password: options.password ? password : null, users, courses: courses.length };
}
