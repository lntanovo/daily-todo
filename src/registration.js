// Passwords stay in memory only. A random retry token prevents duplicate submissions.
export function setupRegistration({ cloudConfig, el }) {
  let busy = false;
  let pendingToken = null;
  let lastAccount = "";
  const tokenKey = "daily-todo.registration-request.v1";
  const accountKey = "daily-todo.last-account.v1";
  try { pendingToken = sessionStorage.getItem(tokenKey); lastAccount = localStorage.getItem(accountKey) || ""; } catch {}
  if (!el("loginUsername").value) el("loginUsername").value = lastAccount;

  function clearPasswords() {
    for (const id of ["registerPassword", "registerConfirm"]) {
      el(id).value = "";
      el(id).type = "password";
      updateEye(document.querySelector(`[data-password-target="${id}"]`), false);
    }
  }
  function show(view) {
    el("loginForm").hidden = view !== "login";
    el("registerForm").hidden = view !== "register";
    el("registerSuccess").hidden = view !== "success";
    requestAnimationFrame(() => el(view === "register" ? "registerName" : view === "success" ? "generatedAccount" : "loginUsername").focus());
  }
  function showFromLocation() {
    if (busy) return;
    show(location.hash === "#join" ? "register" : "login");
  }
  function goLogin() {
    if (busy) return;
    clearPasswords();
    history.replaceState(null, "", location.pathname + location.search);
    show("login");
  }
  function updateEye(button, visible) {
    button.innerHTML = visible
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.2 3M6.1 6.1C3.7 7.8 2.5 12 2.5 12s3.5 6 9.5 6a10 10 0 0 0 3.1-.5"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? "隐藏密码" : "显示密码");
    button.title = visible ? "隐藏密码" : "显示密码";
  }
  document.querySelectorAll("[data-password-target]").forEach(button => {
    updateEye(button, false);
    button.addEventListener("click", () => {
      const input = el(button.dataset.passwordTarget);
      const start = input.selectionStart, end = input.selectionEnd;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      updateEye(button, visible);
      input.focus();
      input.setSelectionRange(start, end);
    });
  });
  el("openRegisterButton").addEventListener("click", () => { location.hash = "join"; show("register"); });
  el("backToLoginButton").addEventListener("click", goLogin);
  addEventListener("hashchange", () => { if (location.hash !== "#join") clearPasswords(); showFromLocation(); });
  el("useAccountButton").addEventListener("click", () => { el("loginUsername").value = lastAccount; goLogin(); el("loginPassword").focus(); });
  el("copyAccountButton").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lastAccount); el("copyAccountMessage").textContent = "已复制，请妥善保存。"; }
    catch { el("generatedAccount").select(); el("copyAccountMessage").textContent = "请长按或按 Ctrl+C 复制选中的账号。"; }
  });
  el("registerForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const nickname = el("registerName").value.trim();
    const relation = el("registerRelation").value.trim();
    const username = el("registerUsername").value.trim().toLowerCase();
    el("registerUsername").value = username;
    const password = el("registerPassword").value;
    const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, /[()!@#$%^&*|?><_-]/].filter(pattern => pattern.test(password)).length;
    const message = el("registerMessage");
    if (nickname.length < 2 || nickname.length > 32 || !relation || relation.length > 80) { message.textContent = "请填写 2–32 字的称呼，以及你和 lntano 的关系。"; return; }
    if (!/^[a-z][a-z0-9_]{4,23}$/.test(username)) { message.textContent = "账号需要 5–24 位，以小写字母开头，只能使用小写字母、数字和下划线。"; return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9()!@#$%^&*|?><_-]{7,31}$/.test(password) || categories < 3) { message.textContent = "密码需要 8–32 位，以字母或数字开头，并包含大写、小写、数字、允许的符号中至少三种。允许的符号：()!@#$%^&*|?><_-"; return; }
    if (password !== el("registerConfirm").value) { message.textContent = "两次密码不一样，请重新确认。"; return; }
    if (!cloudConfig.env || !cloudConfig.accessKey) { message.textContent = "注册服务尚未配置，请联系 lntano。"; return; }
    busy = true;
    el("registerButton").disabled = true;
    el("backToLoginButton").disabled = true;
    message.textContent = "正在创建账号，请不要关闭页面…";
    try {
      if (!/^[a-f0-9]{64}$/.test(pendingToken || "")) pendingToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, "0")).join("");
      try { sessionStorage.setItem(tokenKey, pendingToken); } catch {}
      // Dedicated public HTTP gateway. No login token or server credential is sent.
      const response = await fetch("https://daily-todo-d3gq5mama7a468d02-1485775300.ap-shanghai.app.tcloudbase.com/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname, relation, username, password, requestToken: pendingToken, website: el("registerWebsite").value }),
        signal: AbortSignal.timeout(45000)
      });
      if (!response.ok) throw new Error("REGISTRATION_GATEWAY_UNAVAILABLE");
      const result = await response.json();
      if (!result?.ok) {
        const safeMessages = {
          CLOSED: "注册暂时关闭，请联系 lntano。",
          RATE_LIMIT: "提交过于频繁，请一分钟后再试。",
          DAILY_LIMIT: "今天的注册名额已用完，请明天再来，或联系 lntano。",
          TOTAL_LIMIT: "当前注册名额已满，请联系 lntano。",
          BUSY: "上一次请求还在处理中，请保留此页面，90 秒后再试。",
          CHANGED: "请恢复上次提交的称呼、关系、账号和密码后重试，或联系 lntano。",
          USERNAME_TAKEN: "这个账号已经被使用，请换一个再试。",
          INVALID: "请检查称呼、关系、账号和密码格式。"
        };
        throw Object.assign(new Error("REGISTRATION_FAILED"), { publicMessage: safeMessages[result?.code] });
      }
      if (!/^[a-z][a-z0-9_]{4,23}$/.test(result.username || "")) throw new Error("账号返回异常，请联系 lntano。");
      lastAccount = result.username;
      el("generatedAccount").value = lastAccount;
      pendingToken = null;
      try { sessionStorage.removeItem(tokenKey); localStorage.setItem(accountKey, lastAccount); } catch {}
      clearPasswords();
      show("success");
    } catch (error) {
      // Never render raw CloudBase errors: upstream errors may include request details.
      message.textContent = error.publicMessage || "暂时无法确认注册结果，请保留此页面，90 秒后用原信息重试；不会重复分配账号。";
    } finally {
      busy = false;
      el("registerButton").disabled = false;
      el("backToLoginButton").disabled = false;
    }
  });
  return { showFromLocation };
}
