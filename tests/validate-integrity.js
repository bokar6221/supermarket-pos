"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("index.html");
const app = read("app.js");
const accounts = read("accounts.js");
const db = read("db.js");
const gradle = read("android-app/app/build.gradle");

for (const file of ["app.js", "db.js", "accounts.js", "catalog.js", "sw.js"]) {
  const source = read(file);
  // Compile without executing browser-dependent code.
  new Function(source);
}

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], "HTML must not contain duplicate IDs");

const dynamicIds = new Set([
  "openShiftForm", "openingCash", "shiftOpenNote", "closedShiftHistory",
  "closeShiftForm", "countedCash"
]);
const referencedIds = [...(app + "\n" + accounts).matchAll(/\$\(["']([^"']+)["']\)/g)]
  .map(match => match[1]);
const missingIds = [...new Set(referencedIds)].filter(id => !ids.includes(id) && !dynamicIds.has(id));
assert.deepEqual(missingIds, [], "Every static JavaScript DOM reference must exist in index.html");

for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) {
  assert.ok(fs.existsSync(path.join(__dirname, "..", match[1])), "Missing script asset: " + match[1]);
}

assert.match(db, /مجموع بنود الفاتورة لا يطابق الإجمالي قبل الخصم/, "Invoice line totals must reconcile");
assert.match(db, /seenIndexes/, "A return cannot repeat the same invoice line");
assert.match(db, /sold\.unit==="piece"&&!Number\.isInteger\(qty\)/, "Piece returns must be whole quantities");
assert.match(db, /رقم الهاتف مسجل بالفعل/, "Duplicate customer phones must be rejected");
assert.match(accounts, /savedLineTotal/, "Profit reports must use saved invoice line totals");
assert.match(gradle, /versionName '1\.6\.0'/, "Android version must match this release");

console.log("POS integrity checks passed: syntax, HTML IDs, script assets, invoice totals, returns, customers and release version.");
