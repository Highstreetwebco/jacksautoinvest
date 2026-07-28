(() => {
  "use strict";
  const menuButton = document.querySelector("#menuButton");
  const nav = document.querySelector("#mainNav");
  menuButton.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll("a").forEach(link => link.addEventListener("click", () => {
    nav.classList.remove("open");
    menuButton.setAttribute("aria-expanded", "false");
  }));

  const panel = document.querySelector("#simulationPanel");
  const closePanel = () => {
    panel.hidden = true;
    document.body.style.overflow = "";
  };
  document.querySelector("#runSimulation").addEventListener("click", () => {
    panel.hidden = false;
    document.body.style.overflow = "hidden";
    document.querySelector("#closeSimulation").focus();
  });
  document.querySelector("#closeSimulation").addEventListener("click", closePanel);
  document.querySelector("#finishSimulation").addEventListener("click", closePanel);
  panel.addEventListener("click", event => {
    if (event.target === panel) closePanel();
  });

  document.querySelector("#refreshActivity").addEventListener("click", event => {
    const button = event.currentTarget;
    button.textContent = "Updated ✓";
    setTimeout(() => { button.textContent = "Refresh"; }, 1200);
  });
})();
