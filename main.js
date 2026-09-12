function showStartupError(error) {
  const {t} = require("./src/i18n.js");
  const message = error && error.message ? error.message : String(error);
  const node = document.getElementById("bootError");
  if (!node) {
    setTimeout(() => showStartupError(error), 0);
    return;
  }
  node.textContent = t("startupError", {message});
  node.classList.remove("hidden");
}

try {
  require("./src/main.js");
} catch (error) {
  showStartupError(error);
}
