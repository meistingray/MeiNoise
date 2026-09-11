const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("panel loads a root external controller from the head", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const scriptPosition = html.indexOf('<script src="main.js"></script>');
  assert.ok(scriptPosition > html.indexOf("<head>"));
  assert.ok(scriptPosition < html.indexOf("</head>"));
  assert.doesNotMatch(html, /<script>\s*try/);
  assert.match(html, /控制器未启动/);

  const bootstrap = fs.readFileSync(path.join(root, "main.js"), "utf8");
  assert.match(bootstrap, /require\("\.\/src\/main\.js"\)/);
  assert.match(bootstrap, /MeiNoise 启动失败/);
});

test("compact panel exposes every agreed interaction", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const id of ["analyze", "infoButton", "analysisHint", "amount", "size", "chroma", "seed"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id=["']compare["']/);
  assert.doesNotMatch(html, /id=["'](?:cancel|complete)["']/);
  assert.match(html, /选择图层 → 选择并分析背景 → 调节参数，实时生成/);
  const controller = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  assert.match(controller, /hasBackgroundSelection/);
  assert.match(controller, /listenForBackgroundSelection/);
  assert.doesNotMatch(controller, /setInterval/);
  assert.match(controller, /松开鼠标后自动分析/);
  assert.doesNotMatch(html, /id=["']setTarget["']/);
  assert.doesNotMatch(html, /id=["']preview["']/);
});
