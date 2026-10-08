const ROUTES = Object.freeze({ schedule: "日程", focus: "专注", profile: "个人" });

export function setupNavigation({ root, buttons, panels, onChange = () => {} }) {
  let active = false;
  let current = "schedule";

  function routeFromHash() {
    const route = location.hash.replace(/^#/, "");
    return Object.hasOwn(ROUTES, route) ? route : "schedule";
  }

  function render(route = routeFromHash()) {
    if (!active) return;
    current = route;
    for (const button of buttons) {
      const selected = button.dataset.view === route;
      button.setAttribute("aria-current", selected ? "page" : "false");
      button.classList.toggle("active", selected);
    }
    for (const panel of panels) panel.hidden = panel.dataset.viewPanel !== route;
    document.title = `${ROUTES[route]} · TO DO LIST`;
    root.dataset.currentView = route;
    onChange(route);
  }

  function go(route, { replace = false } = {}) {
    if (!Object.hasOwn(ROUTES, route)) route = "schedule";
    const hash = `#${route}`;
    if (location.hash === hash) return render(route);
    if (replace) {
      history.replaceState(null, "", hash);
      render(route);
    } else location.hash = hash;
  }

  for (const button of buttons) button.addEventListener("click", () => go(button.dataset.view));
  addEventListener("hashchange", () => {
    if (location.hash === "#join") return;
    render();
  });

  return {
    setActive(value) {
      active = Boolean(value);
      if (!active) return;
      if (!Object.hasOwn(ROUTES, location.hash.replace(/^#/, ""))) go("schedule", { replace: true });
      else render();
    },
    go,
    current: () => current
  };
}
