import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = path.join(appRoot, "src", "renderer");
const sourceRoots = [rendererRoot, path.join(appRoot, "src", "automation", "engine", "renderer"), path.join(appRoot, "src", "automation", "engine", "shared")];

function filesUnder(directory, accept) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full, accept);
    return accept(entry.name) ? [full] : [];
  });
}

/** Class names the renderer can produce: literal words plus `prefix-${…}` and `${…}-suffix` templates. */
function classUsage() {
  const text = sourceRoots
    .flatMap((root) => filesUnder(root, (name) => /\.(tsx?|html)$/.test(name) && !/\.test\.tsx?$/.test(name)))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const words = new Set(text.match(/[A-Za-z_][\w-]*/g));
  const prefixes = [...new Set([...text.matchAll(/([A-Za-z][\w-]*-)(?:\$\{|["'`]\s*\+)/g)].map((match) => match[1]))];
  const suffixes = [...new Set([...text.matchAll(/\}(-[\w-]+)/g)].map((match) => match[1]))];
  return (name) => words.has(name) || prefixes.some((prefix) => name.startsWith(prefix)) || suffixes.some((suffix) => name.endsWith(suffix));
}

/** Yields every selector of every style rule, skipping at-rule preludes and keyframe steps. */
function* selectorsOf(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let prelude = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      prelude += source.slice(index, end + 1);
      index = end;
    } else if (char === "{") {
      const text = prelude.trim();
      const inKeyframes = blocks.some((block) => block.keyframes);
      blocks.push({ keyframes: /^@(-\w+-)?keyframes\b/.test(text) });
      if (text && !text.startsWith("@") && !inKeyframes) yield* splitTopLevel(text);
      prelude = "";
    } else if (char === "}") {
      blocks.pop();
      prelude = "";
    } else if (char === ";") {
      prelude = "";
    } else {
      prelude += char;
    }
  }
}

function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === "(") depth += 1;
    else if (list[index] === ")") depth -= 1;
    else if (list[index] === "," && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

/** Classes an element must carry for the selector to match; classes inside :not/:is/:where/:has are optional. */
function requiredClasses(selector) {
  let text = selector;
  for (let pass = 0; pass < 5; pass += 1) text = text.replace(/:(not|is|where|has)\((?:[^()]|\([^()]*\))*\)/g, "");
  return [...text.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
}

test("renderer styles only read custom properties that a stylesheet or component defines", () => {
  const styleFiles = filesUnder(path.join(rendererRoot, "src"), (name) => name.endsWith(".css"));
  const codeFiles = sourceRoots.flatMap((root) => filesUnder(root, (name) => /\.(tsx?|html)$/.test(name) && !/\.test\.tsx?$/.test(name)));
  const defined = new Set();
  for (const file of styleFiles) for (const match of fs.readFileSync(file, "utf8").matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
  // Components set some properties at runtime, e.g. style={{ "--detail-width": … }} or style.setProperty("--…").
  for (const file of codeFiles) for (const match of fs.readFileSync(file, "utf8").matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(match[1]);
  // A read without a fallback of an undefined property makes the whole declaration invalid at computed-value time.
  const undefinedReads = [...styleFiles, ...codeFiles].flatMap((file) =>
    [...fs.readFileSync(file, "utf8").matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
      .filter((match) => !defined.has(match[1]))
      .map((match) => `${path.relative(appRoot, file)}: ${match[1]}`),
  );
  assert.deepEqual([...new Set(undefinedReads)], [], "Use a token from styles/tokens.css or define the property.");
});

test("renderer style rules only target classes the renderer can still produce", () => {
  const used = classUsage();
  const unused = filesUnder(path.join(rendererRoot, "src"), (name) => name.endsWith(".css")).flatMap((file) =>
    [...selectorsOf(fs.readFileSync(file, "utf8"))]
      .filter((selector) => requiredClasses(selector).some((name) => !used(name)))
      .map((selector) => `${path.relative(appRoot, file)}: ${selector}`),
  );
  assert.deepEqual(unused, [], "Delete style rules whose classes no component renders any more.");
});
