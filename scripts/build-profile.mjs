// Renders README.md and assets/header.svg from the files in templates/.
// Run by .github/workflows/profile.yml on a daily schedule.
//
// Placeholders:
//   {{CONTRIBUTIONS}}  contribution count for the last year   (header.svg)
//   {{PEAK}}           busiest single day in that year        (header.svg)
//   {{REPOS}}          public, non-archived repository count  (header.svg)
//   {{RECENT}}         three most recently pushed repos       (README.md)
//   {{UPDATED}}        UTC date of this run                   (README.md)
//
// Every live value falls back to whatever is already published, so an API
// hiccup leaves the page correct instead of blanking a number.

import { readFile, writeFile } from "node:fs/promises";

const USER = process.env.PROFILE_USER || "Hazjel";
const TOKEN = process.env.GITHUB_TOKEN;
const SKIP = new Set([USER]); // the profile repo itself is plumbing, not work

const api = async (url) => {
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

async function calendar() {
  const query = `query($login:String!){
    user(login:$login){
      contributionsCollection{
        contributionCalendar{
          totalContributions
          weeks{ contributionDays{ contributionCount } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  if (!res.ok) throw new Error(`graphql ${res.status}`);
  const cal = (await res.json())?.data?.user?.contributionsCollection
    ?.contributionCalendar;
  if (!cal || typeof cal.totalContributions !== "number") {
    throw new Error("no contribution calendar");
  }
  const peak = Math.max(
    ...cal.weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)),
  );
  return { total: cal.totalContributions, peak };
}

let repoCache = null;
const publicRepos = async () => {
  repoCache ??= (
    await api(`https://api.github.com/users/${USER}/repos?per_page=100&sort=pushed`)
  ).filter((r) => !r.fork && !r.archived && !r.private);
  return repoCache;
};

async function recentRepos() {
  const repos = await publicRepos();
  const picked = repos
    .filter((r) => !SKIP.has(r.name))
    .slice(0, 3);
  if (!picked.length) throw new Error("no repositories");
  return picked
    .map((r) => {
      const when = new Date(r.pushed_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
      const what = r.description
        ? r.description.split(/(?<=\.)\s/)[0].trim()
        : "No description yet.";
      return `- **[${r.name}](${r.html_url})** · ${when}<br>${what}`;
    })
    .join("\n");
}

// Keeps the last published value when the API is unavailable.
const keep = async (fn, file, pattern, label) => {
  try {
    return await fn();
  } catch (err) {
    console.warn(`${label} unavailable (${err.message}), reusing published value`);
    const published = await readFile(file, "utf8").catch(() => "");
    const match = published.match(pattern);
    if (match) return match[1];
    throw new Error(`${label} has no live value and no published fallback`);
  }
};

const stats = await keep(
  async () => {
    const [cal, repos] = await Promise.all([calendar(), publicRepos()]);
    return JSON.stringify({
      total: cal.total.toLocaleString("en-US"),
      peak: String(cal.peak),
      repos: String(repos.filter((r) => !SKIP.has(r.name)).length),
    });
  },
  "assets/header.svg",
  /<!--stats:(.*?)-->/s,
  "contribution calendar",
);
const { total, peak, repos } = JSON.parse(stats);

const recent = await keep(
  recentRepos,
  "README.md",
  /### `› recently pushed`\n\n([\s\S]*?)\n\n###/,
  "recent repositories",
);

const updated = new Date().toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const header = (await readFile("templates/header.tmpl.svg", "utf8"))
  .replaceAll("{{CONTRIBUTIONS}}", total)
  .replaceAll("{{PEAK}}", peak)
  .replaceAll("{{REPOS}}", repos)
  .replace("<!--stats:-->", `<!--stats:${stats}-->`);

const readme = (await readFile("templates/README.tmpl.md", "utf8"))
  .replaceAll("{{RECENT}}", recent)
  .replaceAll("{{UPDATED}}", updated);

await writeFile("assets/header.svg", header);
await writeFile("README.md", readme);

console.log(`contributions: ${total}, peak day: ${peak}, repos: ${repos}, updated: ${updated}`);
