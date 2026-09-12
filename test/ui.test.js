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
  assert.match(bootstrap, /t\("startupError", \{message\}\)/);
  assert.match(bootstrap, /require\("\.\/src\/i18n\.js"\)/);
});

test("compact panel exposes every agreed interaction", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const id of ["pluginVersion", "copyrightButton", "copyrightPopover", "copyrightLink", "analyze", "manualAnalyze", "infoButton", "analysisHint", "amount", "size", "chroma", "seed", "amountInput", "sizeInput", "chromaInput", "seedInput"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id=["']compare["']/);
  assert.doesNotMatch(html, /id=["'](?:cancel|complete)["']/);
  assert.match(html, /选择图层 → 自动生成噪点 → 调节参数，实时更新/);
  assert.match(html, /href="https:\/\/www\.kicity\.com"/);
  assert.match(html, /手动采集样本/);
  assert.match(html, /如何手动采集背景样本/);
  const controller = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  assert.match(controller, /analyzeAroundTarget/);
  assert.match(controller, /beginManualSelection/);
  assert.match(controller, /listenForBackgroundSelection/);
  assert.match(controller, /shell\.openExternal\("https:\/\/www\.kicity\.com"\)/);
  assert.doesNotMatch(controller, /setInterval/);
  assert.match(html, /自动生成噪点/);
  assert.equal((html.match(/ⓘ/g) || []).length, 2);
  assert.doesNotMatch(html, /<svg/);
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(html, /class="manual-analysis-row"/);
  assert.doesNotMatch(html, /manual-row-spacer/);
  assert.match(styles, /#analyze[^}]*width:\s*100%/);
  assert.match(styles, /#analyze[^}]*max-width:\s*100%/);
  assert.match(styles, /#analyze[^}]*white-space:\s*nowrap/);
  assert.match(styles, /\.manual-analysis-row[^}]*display:\s*flex/);
  assert.match(styles, /\.manual-button[^}]*width:\s*79%/);
  assert.match(styles, /\.manual-analysis-row \.info-button[^}]*width:\s*19%/);
  assert.doesNotMatch(styles, /grid-template-columns/);
  assert.doesNotMatch(styles, /(?:44px|54px|120px)/);
  assert.match(styles, /\.button[^}]*justify-content:\s*center/);
  assert.match(styles, /"Segoe UI Symbol"/);
  assert.equal((html.match(/<input[^>]+type="number"/g) || []).length, 4);
  assert.equal((html.match(/<input[^>]+type="range"/g) || []).length, 4);
  assert.doesNotMatch(html, /<sp-(?:textfield|slider)/);
  assert.equal((html.match(/class="value-unit"/g) || []).length, 4);
  assert.match(styles, /input\[type="number"\][^}]*border-radius:\s*1px/);
  assert.match(styles, /input\[type="number"\]:focus[^}]*border-color:\s*#2680eb/);
  assert.match(controller, /onNumberInput/);
  assert.match(controller, /commitNumberInput/);
  assert.match(controller, /host\.uiLocale \|\| host\.locale/);
  assert.match(controller, /function applyLocale\(\)/);
  assert.match(controller, /t\("numericValue"/);
  assert.match(controller, /awaitingManualSelection[\s\S]*t\("manualCancel"\)/);
  assert.match(controller, /function cancelScheduledRender\(\)/);
  assert.match(controller, /cancelScheduledRender\(\);[\s\S]*setBusy\(true\)/);
  assert.doesNotMatch(html, /id=["']setTarget["']/);
  assert.doesNotMatch(html, /id=["']preview["']/);
});
