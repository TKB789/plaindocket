/**
 * Turns data/releases.json into docs/data.json — one flat file the browser
 * downloads once and searches locally. No API calls from the page itself.
 */

import fs from "node:fs";
import path from "node:path";

const store = JSON.parse(fs.readFileSync(path.join("data", "releases.json"), "utf8"));

const records = Object.values(store)
  .filter((r) => r.title && r.url)
  .sort((a, b) => (b.date || 0) - (a.date || 0));

// Pre-lowercased haystack so the browser doesn't rebuild it on every keystroke.
for (const r of records) {
  r.q = [r.title, r.facts, r.district, (r.topics || []).join(" ")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

const count = (key) => {
  const m = new Map();
  for (const r of records) {
    const vals = key === "topics" ? r.topics || [] : [r.district].filter(Boolean);
    for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
};

const withSentence = records.filter((r) => r.months !== null).map((r) => r.months);
const median = withSentence.length
  ? withSentence.sort((a, b) => a - b)[Math.floor(withSentence.length / 2)]
  : null;

const payload = {
  updated: new Date().toISOString(),
  total: records.length,
  medianMonths: median,
  topics: count("topics"),
  districts: count("district"),
  records,
};

fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(path.join("docs", "data.json"), JSON.stringify(payload));

const mb = (fs.statSync(path.join("docs", "data.json")).size / 1048576).toFixed(2);
console.log(`wrote docs/data.json — ${records.length} records, ${mb} MB`);
if (mb > 8) console.warn("Over 8 MB. Shorten WINDOW_DAYS or split the file by year.");
