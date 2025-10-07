// ==UserScript==
// @name         ChatGPT Q/A Jump Nav (article-based)
// @namespace    chatgpt-nav
// @version      1.5.0
// @description  Shift+Scroll to jump within/between ChatGPT messages; size-aware for short articles
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SELECTOR = 'article[data-testid^="conversation-turn-"]';

  function findScroller(startEl) {
    let el =
      startEl ||
      document.querySelector(SELECTOR) ||
      document.documentElement ||
      document.body;
    while (el && el !== document.body && el !== document.documentElement) {
      const s = getComputedStyle(el);
      if (/(auto|scroll)/.test(s.overflowY)) return el;
      el = el.parentElement;
    }
    return window;
  }

  function getMessages() {
    return Array.from(document.querySelectorAll(SELECTOR));
  }

  let messages = getMessages();
  let SCROLLER = findScroller(messages[0] || null);

  const mo = new MutationObserver(() => {
    messages = getMessages();
    if (messages.length) SCROLLER = findScroller(messages[0]);
  });
  mo.observe(document.documentElement, { subtree: true, childList: true });
  window.addEventListener("resize", () => {
    if (messages.length) SCROLLER = findScroller(messages[0]);
  });

  const scrollY = () =>
    SCROLLER === window ? window.scrollY : SCROLLER.scrollTop;
  const viewH = () =>
    SCROLLER === window ? window.innerHeight : SCROLLER.clientHeight;
  const rawScrollTo = (y, behavior = "smooth") => {
    if (SCROLLER === window) window.scrollTo({ top: y, behavior });
    else SCROLLER.scrollTo({ top: y, behavior });
  };
  const absTopRaw = (el) => el.getBoundingClientRect().top + scrollY();
  const absBottomRaw = (el) => el.getBoundingClientRect().bottom + scrollY();

  const PAD = 8;
  const EDGE_EPS = 16;
  const CORRECT_EPS = 4;
  const MIN_ADVANCE = 32;
  const FORCE_MS = 600;
  const WHEEL_DEBOUNCE_MS = 220;
  const ANIM_LOCK_MS = 320;

  const absTop = (i) => absTopRaw(messages[i]);
  const absBottom = (i) => absBottomRaw(messages[i]);
  const posTop = (i) => absTop(i) - PAD;
  const posBottom = (i) => absBottom(i) - viewH() + PAD;

  // Article is "short" if its height is <= visible area (minus a bit of padding)
  function isShort(i) {
    if (i < 0) return false;
    const h = absBottom(i) - absTop(i);
    return h <= viewH() - 2 * PAD + EDGE_EPS;
  }

  // Forced index window after cross-article snaps (prevents race with smooth scroll)
  let forcedIdx = null;
  let forceUntil = 0;
  function setForcedIndex(i) {
    forcedIdx = i;
    forceUntil = Date.now() + FORCE_MS;
  }
  function correctIfNear(targetY) {
    requestAnimationFrame(() => {
      const cur = scrollY();
      if (Math.abs(cur - targetY) <= CORRECT_EPS) rawScrollTo(targetY, "auto");
    });
  }

  // Monotonic scroll with optional guaranteed progress for same-article jumps.
  function safeScrollTo(
    targetY,
    dir,
    opts = { minAdvance: false, exact: false, afterSnap: null }
  ) {
    const y = scrollY();
    if (dir === "up") {
      if (opts.exact) {
        rawScrollTo(targetY, "smooth");
        correctIfNear(targetY);
        if (typeof opts.afterSnap === "number") setForcedIndex(opts.afterSnap);
        return;
      }
      if (targetY >= y - 1) {
        if (opts.minAdvance) rawScrollTo(y - MIN_ADVANCE, "smooth");
        return;
      }
      rawScrollTo(targetY, "smooth");
    } else {
      if (opts.exact) {
        rawScrollTo(targetY, "smooth");
        correctIfNear(targetY);
        if (typeof opts.afterSnap === "number") setForcedIndex(opts.afterSnap);
        return;
      }
      if (targetY <= y + 1) {
        if (opts.minAdvance) rawScrollTo(y + MIN_ADVANCE, "smooth");
        return;
      }
      rawScrollTo(targetY, "smooth");
    }
  }

  const goTopExact = (i, dir) =>
    i >= 0 && safeScrollTo(posTop(i), dir, { exact: true, afterSnap: i });
  const goBottomExact = (i, dir) =>
    i >= 0 && safeScrollTo(posBottom(i), dir, { exact: true, afterSnap: i });
  const goTopNudged = (i, dir) =>
    i >= 0 && safeScrollTo(posTop(i), dir, { minAdvance: true });
  const goBottomNudged = (i, dir) =>
    i >= 0 && safeScrollTo(posBottom(i), dir, { minAdvance: true });

  function currentIndex() {
    if (!messages.length) return -1;
    const now = Date.now();
    if (forcedIdx != null && now < forceUntil) return forcedIdx;
    const yTop = scrollY();
    let idx = 0;
    for (let i = 0; i < messages.length; i++) {
      if (posTop(i) <= yTop + EDGE_EPS) idx = i;
      else break;
    }
    return idx;
  }
  const clamp = (i) => Math.max(0, Math.min(messages.length - 1, i));

  function atTop(i) {
    return i >= 0 && Math.abs(scrollY() - posTop(i)) <= EDGE_EPS;
  }
  function atBottom(i) {
    return i >= 0 && Math.abs(scrollY() - posBottom(i)) <= EDGE_EPS;
  }

  function typingInBox(e) {
    const tag = ((e.target && e.target.tagName) || "").toLowerCase();
    return tag === "input" || tag === "textarea" || e.target?.isContentEditable;
  }

  // Alt+Arrows (unchanged)
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || typingInBox(e)) return;
      const i = currentIndex();
      if (e.key === "ArrowUp" && !e.shiftKey) {
        e.preventDefault();
        goTopExact(i, "up");
      } else if (e.key === "ArrowDown" && !e.shiftKey) {
        e.preventDefault();
        goBottomExact(i, "down");
      } else if (e.key === "ArrowUp" && e.shiftKey) {
        e.preventDefault();
        goTopExact(clamp(i - 1), "up");
      } else if (e.key === "ArrowDown" && e.shiftKey) {
        e.preventDefault();
        goTopExact(clamp(i + 1), "down");
      }
    },
    { capture: true }
  );

  // Shift+Scroll (size-aware & monotonic)
  let lastWheelAt = 0;
  let animLock = false;

  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.shiftKey || typingInBox(e)) return;

      const now = Date.now();
      if (animLock || now - lastWheelAt < WHEEL_DEBOUNCE_MS) {
        e.preventDefault();
        return;
      }
      lastWheelAt = now;

      const dx = e.deltaX || 0;
      const dy = e.deltaY || 0;
      const net = Math.abs(dy) >= Math.abs(dx) ? dy : dx;

      const i = currentIndex();
      if (i < 0) return;

      animLock = true;
      setTimeout(() => (animLock = false), ANIM_LOCK_MS);

      if (net > 0) {
        // Shift + scroll DOWN
        e.preventDefault();

        const short = isShort(i);
        if (atBottom(i)) {
          const next = clamp(i + 1);
          if (next !== i) {
            goTopExact(next, "down"); // cross-article snap
          } else {
            // last item: try bottom (might be same), then gentle nudge
            if (short) rawScrollTo(scrollY() + MIN_ADVANCE, "smooth");
            else goBottomNudged(i, "down");
          }
        } else if (atTop(i)) {
          if (short) {
            // short article: skip "bottom of same", go to top of NEXT
            const next = clamp(i + 1);
            if (next !== i) goTopExact(next, "down");
            else rawScrollTo(scrollY() + MIN_ADVANCE, "smooth");
          } else {
            goBottomNudged(i, "down");
          }
        } else {
          if (short) {
            // in the middle of a short article: move on to NEXT
            const next = clamp(i + 1);
            if (next !== i) goTopExact(next, "down");
            else rawScrollTo(scrollY() + MIN_ADVANCE, "smooth");
          } else {
            goBottomNudged(i, "down");
          }
        }
      } else if (net < 0) {
        // Shift + scroll UP
        e.preventDefault();

        const short = isShort(i);
        if (atTop(i)) {
          const prev = clamp(i - 1);
          if (prev !== i) {
            goBottomExact(prev, "up"); // cross-article snap
          } else {
            if (short) rawScrollTo(scrollY() - MIN_ADVANCE, "smooth");
            else goTopNudged(i, "up");
          }
        } else if (atBottom(i)) {
          if (short) {
            // short article: skip "top of same", go to bottom of PREVIOUS
            const prev = clamp(i - 1);
            if (prev !== i) goBottomExact(prev, "up");
            else rawScrollTo(scrollY() - MIN_ADVANCE, "smooth");
          } else {
            goTopNudged(i, "up");
          }
        } else {
          if (short) {
            // in the middle of a short article: move on to PREVIOUS
            const prev = clamp(i - 1);
            if (prev !== i) goBottomExact(prev, "up");
            else rawScrollTo(scrollY() - MIN_ADVANCE, "smooth");
          } else {
            goTopNudged(i, "up");
          }
        }
      }
    },
    { capture: true, passive: false }
  );
})();
