/** Run with: node scripts/extract.test.js */
import { extractSentence, stripHtml, districtOf } from "./extract.js";

const cases = [
  ["Villalobos-Galdamez, 27, was sentenced by Senior U.S. District Judge B. Lynn Winmill to 120 months in federal prison for possession with intent to distribute methamphetamine.", 120],
  ["Oswald Charles Reyna, 67, of Nampa, was sentenced to 78 months in federal prison following his conviction for distribution of methamphetamine.", 78],
  ["Aaron Vincent Fretz, 41, of Nampa, was sentenced to 4 years and 9 months in federal prison for distribution of fentanyl.", 57],
  ["The defendant was sentenced to life in prison without the possibility of parole.", null],
  ["Smith was sentenced to 10 years in prison and ordered to pay $2.4 million in restitution.", 120],
  ["Jones was sentenced to three years of probation.", null],
  ["A federal grand jury returned an indictment charging Doe with wire fraud.", null],
];

let pass = 0;
for (const [text, expect] of cases) {
  const got = extractSentence(text);
  const months = got?.months ?? null;
  const ok = months === expect;
  if (ok) pass++;
  console.log(`${ok ? "ok  " : "FAIL"}  months=${months} expected=${expect}  label="${got?.label ?? "—"}"`);
}

console.log(`\nhtml: "${stripHtml("<p>Fraud &amp; abuse&nbsp;charges</p>")}"`);
console.log(`district: ${districtOf([{ name: "USAO - Idaho" }, { name: "FBI" }])}`);
console.log(`\n${pass}/${cases.length} passed`);
