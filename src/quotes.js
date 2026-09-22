import { QUOTE_CATALOG, QUOTE_MODES } from "./quote-catalog.js";
import { shanghaiTodayKey } from "./date-display.js";

function safeRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeWrite(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function hash(value) {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

export function setupQuotes({ textElement, metaElement, nextButton, modeContainer, librarySelect, customInput, customButton, getUid }) {
  modeContainer.innerHTML = QUOTE_MODES.map(mode => `<label><input type="radio" name="quoteMode" value="${mode.value}"><span>${mode.label}</span></label>`).join("");
  const categoryLabel = { chuunibyou: "中二", abstract: "抽象", classic: "名言" };
  librarySelect.innerHTML = `<option value="">从 ${QUOTE_CATALOG.length} 句中直接选择</option>${Object.entries(categoryLabel).map(([category, label]) => `<optgroup label="${label}">${QUOTE_CATALOG.filter(quote => quote.category === category).map(quote => `<option value="${quote.id}">${quote.text}</option>`).join("")}</optgroup>`).join("")}<option value="__custom__">我的自定义句子</option>`;
  let active = false;
  let current = null;
  let mode = "mixed";

  const uid = () => getUid() || "guest";
  const modeKey = () => `daily-todo.quote-mode.v1:${uid()}`;
  const dailyKey = () => `daily-todo.quote.v1:${uid()}:${shanghaiTodayKey()}`;
  const customKey = () => `daily-todo.custom-quote.v1:${uid()}`;
  const candidates = () => mode === "mixed" ? QUOTE_CATALOG : QUOTE_CATALOG.filter(quote => quote.category === mode);

  function display(quote) {
    current = quote;
    textElement.textContent = `「${quote.text}」`;
    metaElement.textContent = quote.author ? `${quote.author}${quote.source ? ` · ${quote.source}` : ""}` : "";
    metaElement.hidden = !quote.author;
    librarySelect.value = quote.id === "__custom__" ? "__custom__" : quote.id;
    safeWrite(dailyKey(), quote.id);
  }

  function pick({ advance = false } = {}) {
    const pool = candidates();
    if (!pool.length) return;
    const storedId = safeRead(dailyKey());
    if (!advance && storedId) {
      if (storedId === "__custom__") {
        const customText = safeRead(customKey());
        if (customText) return display({ id: "__custom__", category: "custom", text: customText });
      }
      const stored = QUOTE_CATALOG.find(quote => quote.id === storedId);
      if (stored) return display(stored);
    }
    const available = advance && pool.length > 1 ? pool.filter(quote => quote.id !== current?.id) : pool;
    const seed = advance ? `${Date.now()}-${Math.random()}` : `${uid()}-${shanghaiTodayKey()}-${mode}`;
    display(available[hash(seed) % available.length]);
  }

  function load() {
    mode = safeRead(modeKey()) || "mixed";
    if (!QUOTE_MODES.some(item => item.value === mode)) mode = "mixed";
    const input = modeContainer.querySelector(`[value="${mode}"]`);
    if (input) input.checked = true;
    customInput.value = safeRead(customKey()) || "";
    pick();
  }

  nextButton.addEventListener("click", () => pick({ advance: true }));
  modeContainer.addEventListener("change", event => {
    if (!event.target.matches('input[name="quoteMode"]')) return;
    mode = event.target.value;
    safeWrite(modeKey(), mode);
    current = null;
    pick({ advance: true });
  });
  librarySelect.addEventListener("change", () => {
    if (!librarySelect.value) return;
    if (librarySelect.value === "__custom__") {
      const customText = customInput.value.trim() || safeRead(customKey());
      if (customText) display({ id: "__custom__", category: "custom", text: customText });
      else customInput.focus();
      return;
    }
    const quote = QUOTE_CATALOG.find(item => item.id === librarySelect.value);
    if (quote) display(quote);
  });
  customButton.addEventListener("click", () => {
    const text = customInput.value.trim();
    if (!text) {
      customInput.setCustomValidity("请先输入一句话。");
      customInput.reportValidity();
      return;
    }
    customInput.setCustomValidity("");
    safeWrite(customKey(), text);
    display({ id: "__custom__", category: "custom", text });
  });
  customInput.addEventListener("input", () => customInput.setCustomValidity(""));

  return {
    setActive(value) {
      active = Boolean(value);
      if (active) load();
      else { current = null; textElement.textContent = ""; metaElement.textContent = ""; }
    },
    refreshDay() { if (active) { current = null; pick(); } }
  };
}
