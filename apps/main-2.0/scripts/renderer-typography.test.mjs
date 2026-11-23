import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = path.join(appRoot, "src", "renderer", "src");
const tokensFile = path.join(rendererRoot, "styles", "tokens.css");
const tsxRoots = [rendererRoot, path.join(appRoot, "src", "automation", "engine", "renderer")];

function filesUnder(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  });
}

const allowed = {
  "font-size": /^(var\(--type-(xs|sm|base|md|lg|xl|2xl)\)|inherit|0|[\d.]+em|[\d.]+%|.*var\(--(message|control)-font-size\b.*)$/,
  "font-weight": /^(400|500|600|inherit)$/,
  "font-family": /^(var\(--font-(sans|mono)\)|inherit)$/,
  font: /^inherit$/,
};

test("renderer styles take font sizes, weights and families only from the design tokens", () => {
  const violations = [];
  for (const file of filesUnder(rendererRoot, ".css")) {
    if (file === tokensFile) continue;
    const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const relative = path.relative(appRoot, file);
    for (const match of css.matchAll(/(?:^|[;{\s])(font-size|font-weight|font-family|font|letter-spacing|text-transform)\s*:\s*([^;}]+)/g)) {
      const [, property, raw] = match;
      const value = raw.trim().replace(/\s*!important$/, "");
      if (property === "letter-spacing" || (property === "text-transform" && value === "uppercase")) {
        violations.push(`${relative}: ${property}: ${value}`);
      } else if (allowed[property] && !allowed[property].test(value)) {
        violations.push(`${relative}: ${property}: ${value}`);
      }
    }
    if (/@font-face/.test(css)) violations.push(`${relative}: @font-face`);
  }
  assert.deepEqual(violations, [], "Use the --type-*, --font-* tokens and the 400/500/600 weights from styles/tokens.css.");
});

test("renderer components do not set typography inline", () => {
  const violations = tsxRoots
    .flatMap((root) => filesUnder(root, ".tsx"))
    .filter((file) => !file.endsWith(".test.tsx"))
    .filter((file) => /\b(fontSize|fontWeight|fontFamily|letterSpacing|textTransform)\s*:/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(appRoot, file));
  assert.deepEqual(violations, []);
});
