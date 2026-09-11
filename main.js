function showStartupError(error) {
  const message = error && error.message ? error.message : String(error);
  const node = document.getElementById("bootError");
  if (!node) {
    setTimeout(() => showStartupError(error), 0);
    return;
  }
  node.textContent = "MeiNoise 启动失败：" + message;
  node.classList.remove("hidden");
}

try {
  require("./src/main.js");
} catch (error) {
  showStartupError(error);
}
