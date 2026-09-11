const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("panel loads its controller after the interactive DOM", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const scriptPosition = html.indexOf('<script src="src/main.js"></script>');
  assert.ok(scriptPosition > html.indexOf("</main>"));
});

test("compact panel exposes every agreed interaction", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const id of ["analyze", "infoButton", "amount", "size", "chroma", "seed", "compare", "cancel", "complete"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id=["']setTarget["']/);
  assert.doesNotMatch(html, /id=["']preview["']/);
});
