const test = require("node:test");
const assert = require("node:assert/strict");
const {STRINGS, setLocale, getLanguage, t} = require("../src/i18n.js");
const {combineGrainAnalyses} = require("../src/math.js");

test("Chinese and English dictionaries expose the same keys", () => {
  assert.deepEqual(Object.keys(STRINGS.zh).sort(), Object.keys(STRINGS.en).sort());
});

test("locale selection uses Chinese only for zh locales", () => {
  assert.equal(setLocale("zh-Hans"), "zh");
  assert.equal(getLanguage(), "zh");
  assert.equal(t("analyze"), "自动生成噪点");
  assert.equal(t("surroundingSource", {count: 4}), "4 个周边样本");

  assert.equal(setLocale("en-US"), "en");
  assert.equal(getLanguage(), "en");
  assert.equal(t("analyze"), "Generate Grain");
  assert.equal(t("surroundingSource", {count: 4}), "4 surrounding samples");

  assert.equal(setLocale("ja-JP"), "en");
  setLocale("zh-CN");
});

test("algorithm errors follow the selected locale without text matching", () => {
  setLocale("en-US");
  assert.throws(() => combineGrainAnalyses([]), (error) => {
    assert.equal(error.code, "MEINOISE_NO_USABLE_BACKGROUND");
    assert.match(error.message, /Not enough usable background/);
    return true;
  });
  setLocale("zh-CN");
});
