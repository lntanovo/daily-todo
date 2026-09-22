// Companion motion is adapted from the MIT-licensed oneko.js state machine.
// Petal timing is inspired by the MIT-licensed Sakura.js project.
// See THIRD_PARTY_NOTICES.md for source revisions and license text.

const MOTION_KEY = "daily-todo.motion.v1";
const PET_ENABLED_KEY = "daily-todo.pet-enabled.v1";
const PET_POSITION_KEY = "daily-todo.pet-position.v1";
const SPRITE_SIZE = 32;

const SPRITES = {
  idle: [[-3, -3]],
  alert: [[-7, -3]],
  scratchSelf: [[-5, 0], [-6, 0], [-7, 0]],
  scratchWallN: [[0, 0], [0, -1]],
  scratchWallS: [[-7, -1], [-6, -2]],
  scratchWallE: [[-2, -2], [-2, -3]],
  scratchWallW: [[-4, 0], [-4, -1]],
  tired: [[-3, -2]],
  sleeping: [[-2, 0], [-2, -1]],
  N: [[-1, -2], [-1, -3]],
  NE: [[0, -2], [0, -3]],
  E: [[-3, 0], [-3, -1]],
  SE: [[-5, -1], [-5, -2]],
  S: [[-6, -3], [-7, -2]],
  SW: [[-5, -3], [-6, -1]],
  W: [[-4, -2], [-4, -3]],
  NW: [[-1, 0], [-1, -1]]
};

const ENCOURAGEMENTS = [
  "这一件，收好了。",
  "做得好，再慢慢来。",
  "今天又向前了一点。",
  "清单正在变轻。"
];

const PET_REPLIES = [
  "摸到啦，今天也一起加油。",
  "我会乖乖待在这里。",
  "先做一件最重要的小事吧。",
  "累了就歇一下，我陪你。"
];

function storedPreference() {
  try { return localStorage.getItem(MOTION_KEY); }
  catch { return null; }
}

function savePreference(value) {
  try { localStorage.setItem(MOTION_KEY, value ? "on" : "off"); }
  catch { /* 动效偏好无法保存时，当前页面仍可继续使用。 */ }
}

function storedPetPreference() {
  try { return localStorage.getItem(PET_ENABLED_KEY); }
  catch { return null; }
}

function savePetPreference(value) {
  try { localStorage.setItem(PET_ENABLED_KEY, value ? "on" : "off"); }
  catch { /* 宠物偏好无法保存时，当前页面仍可继续使用。 */ }
}

function storedPetPosition() {
  try {
    const value = JSON.parse(localStorage.getItem(PET_POSITION_KEY));
    if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) return null;
    return {
      x: Math.min(Math.max(value.x, 0), 1),
      y: Math.min(Math.max(value.y, 0), 1)
    };
  } catch {
    return null;
  }
}

function savePetPosition(value) {
  try { localStorage.setItem(PET_POSITION_KEY, JSON.stringify(value)); }
  catch { /* 宠物位置无法保存时，当前页面仍可继续拖动。 */ }
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function setupCompanion({ motionButton, petButton }) {
  const layer = document.createElement("div");
  layer.className = "companion-layer";
  layer.hidden = true;

  const pet = document.createElement("button");
  pet.className = "companion-pet";
  pet.type = "button";
  pet.setAttribute("aria-label", "点击互动，拖动调整宠物位置");
  pet.title = "点击摸摸，拖动换位置";
  const sprite = document.createElement("span");
  sprite.className = "companion-sprite";
  sprite.setAttribute("aria-hidden", "true");
  sprite.style.backgroundImage = `url(${new URL("../assets/oneko.gif", import.meta.url).href})`;
  pet.appendChild(sprite);

  const message = document.createElement("div");
  message.className = "companion-message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.hidden = true;

  const petals = document.createElement("div");
  petals.className = "companion-petals";
  petals.setAttribute("aria-hidden", "true");
  layer.append(pet, message, petals);
  document.body.appendChild(layer);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const preference = storedPreference();
  let motionEnabled = preference === null ? !reducedMotion : preference === "on";
  const petPreference = storedPetPreference();
  let petEnabled = petPreference === null ? true : petPreference === "on";
  let active = false;
  let ambientTimer = 0;
  let messageTimer = 0;
  let animationFrame = 0;
  let lastFrameAt = 0;
  let frameCount = 0;
  let idleTime = 0;
  let idleAnimation = null;
  let idleAnimationFrame = 0;
  let reactionStartedAt = 0;
  let reactionEndsAt = 0;
  let petPosition = storedPetPosition();
  let dragState = null;
  let suppressClickUntil = 0;

  const petVisible = () => active && petEnabled && !document.hidden;
  const motionVisible = () => active && motionEnabled && !document.hidden;

  function setSprite(name, frame = 0) {
    const frames = SPRITES[name] || SPRITES.idle;
    const [x, y] = frames[frame % frames.length];
    sprite.style.backgroundPosition = `${x * SPRITE_SIZE}px ${y * SPRITE_SIZE}px`;
  }

  function petCenter() {
    const rect = pet.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function positionMessage() {
    if (message.hidden) return;
    const petRect = pet.getBoundingClientRect();
    const messageWidth = message.offsetWidth || 180;
    const messageHeight = message.offsetHeight || 42;
    const centerX = clamp(
      petRect.left + petRect.width / 2,
      messageWidth / 2 + 10,
      window.innerWidth - messageWidth / 2 - 10
    );
    const placeBelow = petRect.top < messageHeight + 20;
    message.classList.toggle("is-below", placeBelow);
    message.style.left = `${centerX}px`;
    message.style.top = placeBelow ? `${petRect.bottom + 10}px` : `${petRect.top - 10}px`;
  }

  function placePet(left, top) {
    const width = pet.offsetWidth || 84;
    const height = pet.offsetHeight || 84;
    const safeLeft = clamp(left, 6, window.innerWidth - width - 6);
    const safeTop = clamp(top, 6, window.innerHeight - height - 6);
    pet.style.right = "auto";
    pet.style.bottom = "auto";
    pet.style.left = `${safeLeft}px`;
    pet.style.top = `${safeTop}px`;
    positionMessage();
  }

  function restorePetPosition() {
    if (!petPosition) return;
    const width = pet.offsetWidth || 84;
    const height = pet.offsetHeight || 84;
    placePet(petPosition.x * window.innerWidth - width / 2, petPosition.y * window.innerHeight - height / 2);
  }

  function rememberPetPosition() {
    const { x, y } = petCenter();
    petPosition = {
      x: clamp(x / window.innerWidth, 0, 1),
      y: clamp(y / window.innerHeight, 0, 1)
    };
    savePetPosition(petPosition);
  }

  function resetIdleAnimation() {
    idleAnimation = null;
    idleAnimationFrame = 0;
  }

  function idle() {
    idleTime += 1;
    if (idleTime > 10 && Math.floor(Math.random() * 180) === 0 && idleAnimation === null) {
      const choices = ["sleeping", "scratchSelf"];
      idleAnimation = choices[Math.floor(Math.random() * choices.length)];
    }

    if (idleAnimation === "sleeping") {
      setSprite(idleAnimationFrame < 8 ? "tired" : "sleeping", Math.floor(idleAnimationFrame / 4));
      if (idleAnimationFrame > 160) resetIdleAnimation();
      else idleAnimationFrame += 1;
      return;
    }
    if (idleAnimation) {
      setSprite(idleAnimation, idleAnimationFrame);
      if (idleAnimationFrame > 9) resetIdleAnimation();
      else idleAnimationFrame += 1;
      return;
    }
    setSprite("idle");
  }

  function updatePet(timestamp) {
    frameCount += 1;
    if (timestamp < reactionEndsAt) {
      setSprite("scratchSelf", Math.floor((timestamp - reactionStartedAt) / 120));
      return;
    }
    idle();
  }

  function animate(timestamp) {
    if (petVisible() && motionEnabled && timestamp - lastFrameAt >= 120) {
      lastFrameAt = timestamp;
      updatePet(timestamp);
    }
    animationFrame = requestAnimationFrame(animate);
  }

  function createPetal({ kind = "ambient", x = Math.random() * window.innerWidth, y = -24 } = {}) {
    if (!motionVisible()) return;
    if (kind === "ambient" && petals.querySelectorAll('[data-kind="ambient"]').length >= 7) return;
    const petal = document.createElement("i");
    petal.className = `companion-petal ${kind}`;
    petal.dataset.kind = kind;
    const size = randomBetween(kind === "burst" ? 7 : 8, kind === "burst" ? 14 : 12);
    const colors = ["#c65432", "#d87960", "#e4a28e", "#f0c7b8", "#fff2e4"];
    petal.style.left = `${x}px`;
    petal.style.top = `${y}px`;
    petal.style.width = `${size}px`;
    petal.style.height = `${size * .68}px`;
    petal.style.setProperty("--petal-color", colors[Math.floor(Math.random() * colors.length)]);
    petal.style.setProperty("--turn", `${randomBetween(240, 760)}deg`);
    if (kind === "ambient") {
      petal.style.setProperty("--drift", `${randomBetween(-130, 150)}px`);
      petal.style.setProperty("--sway", `${randomBetween(-28, 28)}px`);
      petal.style.setProperty("--duration", `${randomBetween(8, 13)}s`);
    } else {
      const angle = randomBetween(Math.PI * 1.05, Math.PI * 1.95);
      const distance = randomBetween(46, 145);
      petal.style.setProperty("--burst-x", `${Math.cos(angle) * distance}px`);
      petal.style.setProperty("--burst-y", `${Math.sin(angle) * distance - randomBetween(20, 70)}px`);
      petal.style.setProperty("--duration", `${randomBetween(.75, 1.45)}s`);
    }
    petal.addEventListener("animationend", () => petal.remove(), { once: true });
    petals.appendChild(petal);
  }

  function startAmbient() {
    if (ambientTimer || !motionVisible()) return;
    createPetal();
    ambientTimer = window.setInterval(() => createPetal(), 1700);
  }

  function stopAmbient() {
    window.clearInterval(ambientTimer);
    ambientTimer = 0;
    petals.replaceChildren();
  }

  function sync() {
    const show = active && (petEnabled || motionEnabled);
    layer.hidden = !show;
    pet.hidden = !active || !petEnabled;
    document.documentElement.dataset.motion = motionEnabled ? "on" : "off";
    document.documentElement.dataset.pet = petEnabled ? "on" : "off";
    motionButton.setAttribute("aria-pressed", String(motionEnabled));
    motionButton.textContent = motionEnabled ? "花瓣动效 / MOTION ON" : "花瓣动效 / MOTION OFF";
    motionButton.title = motionEnabled ? "关闭花瓣和宠物动作" : "开启花瓣和宠物动作";
    petButton.setAttribute("aria-pressed", String(petEnabled));
    petButton.textContent = petEnabled ? "宠物 / PET ON" : "宠物 / PET OFF";
    petButton.title = petEnabled ? "隐藏宠物" : "显示宠物";
    if (petVisible()) {
      restorePetPosition();
      if (!motionEnabled) setSprite("idle");
    } else {
      message.hidden = true;
    }
    if (motionVisible()) {
      startAmbient();
    } else {
      stopAmbient();
    }
  }

  function say(text) {
    window.clearTimeout(messageTimer);
    message.textContent = text;
    message.hidden = false;
    positionMessage();
    messageTimer = window.setTimeout(() => { message.hidden = true; }, 2400);
  }

  function startDrag(event) {
    if (!petVisible() || (event.pointerType === "mouse" && event.button !== 0)) return;
    const rect = pet.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false
    };
    suppressClickUntil = 0;
    pet.setPointerCapture(event.pointerId);
    pet.classList.add("is-dragging");
    event.preventDefault();
  }

  function dragPet(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    if (!dragState.moved && Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) < 5) return;
    dragState.moved = true;
    placePet(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
    event.preventDefault();
  }

  function finishDrag(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    if (pet.hasPointerCapture(event.pointerId)) pet.releasePointerCapture(event.pointerId);
    pet.classList.remove("is-dragging");
    if (moved) {
      rememberPetPosition();
      suppressClickUntil = Date.now() + 350;
      say("好，我就待在这里。");
    }
  }

  function petTheCat() {
    if (!petVisible()) return;
    if (motionEnabled) {
      reactionStartedAt = performance.now();
      reactionEndsAt = reactionStartedAt + 960;
      resetIdleAnimation();
      pet.classList.remove("is-interacting");
      void pet.offsetWidth;
      pet.classList.add("is-interacting");
      pet.addEventListener("animationend", () => pet.classList.remove("is-interacting"), { once: true });
    }
    say(PET_REPLIES[Math.floor(Math.random() * PET_REPLIES.length)]);
    if (motionEnabled) {
      const { x, y } = petCenter();
      for (let index = 0; index < 5; index += 1) {
        window.setTimeout(() => createPetal({ kind: "burst", x, y }), index * 28);
      }
    }
  }

  function celebrate({ allDone = false } = {}) {
    if (!active) return;
    if (petVisible()) {
      if (motionEnabled) {
        pet.classList.remove("is-celebrating");
        void pet.offsetWidth;
        pet.classList.add("is-celebrating");
        pet.addEventListener("animationend", () => pet.classList.remove("is-celebrating"), { once: true });
      }
      say(allDone ? "今天的清单，漂亮收尾。" : ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)]);
    }
    if (!motionEnabled) return;
    const count = allDone ? 24 : 10;
    const { x, y } = petVisible() ? petCenter() : { x: window.innerWidth / 2, y: window.innerHeight * .8 };
    for (let index = 0; index < count; index += 1) {
      window.setTimeout(() => createPetal({ kind: "burst", x, y }), index * 22);
    }
  }

  motionButton.addEventListener("click", () => {
    motionEnabled = !motionEnabled;
    savePreference(motionEnabled);
    sync();
  });
  petButton.addEventListener("click", () => {
    petEnabled = !petEnabled;
    savePetPreference(petEnabled);
    sync();
  });
  pet.addEventListener("pointerdown", startDrag);
  pet.addEventListener("pointermove", dragPet);
  pet.addEventListener("pointerup", finishDrag);
  pet.addEventListener("pointercancel", finishDrag);
  pet.addEventListener("click", event => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      return;
    }
    petTheCat();
  });
  document.addEventListener("visibilitychange", () => motionVisible() ? startAmbient() : stopAmbient());
  window.addEventListener("resize", restorePetPosition, { passive: true });

  setSprite("idle");
  sync();
  animationFrame = requestAnimationFrame(animate);

  return {
    celebrate,
    setActive(value) {
      active = Boolean(value);
      sync();
    },
    destroy() {
      cancelAnimationFrame(animationFrame);
      stopAmbient();
      layer.remove();
    }
  };
}
