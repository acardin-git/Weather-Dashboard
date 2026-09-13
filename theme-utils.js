/* ==========================================================================
   theme-utils.js
   Shared across index.html and calendar.html. Two small utilities:

     1. loadBlueprintFonts() — only Blueprint uses Caveat + Special Elite.
        Modern and Dark use the platform system font (--font-tech), so
        loading the Google Fonts stylesheet for them wasted ~30KB and
        triggered a useless font swap on first paint. Call once at boot
        when the resolved theme is Blueprint, and again from setTheme()
        if the user later switches *to* Blueprint.

     2. slidePill(el, target%) — critically-damped RAF spring for the
        segmented control pills (theme switcher, unit toggle). Reads
        from the current presentation value, so a second click mid-slide
        re-targets from where the pill actually is on screen — no jump,
        no seam. Velocity carries through the re-target (no brick wall).
        Apple reference: damping 1.0, response ~0.35s.
   ========================================================================== */

(function () {
  "use strict";

  const FONT_HREF =
    "https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&family=Special+Elite&display=swap";

  function loadBlueprintFonts() {
    if (document.querySelector("link[data-gfont]")) return;

    const preconnect1 = document.createElement("link");
    preconnect1.rel = "preconnect";
    preconnect1.href = "https://fonts.googleapis.com";
    preconnect1.setAttribute("data-gfont", "");
    document.head.appendChild(preconnect1);

    const preconnect2 = document.createElement("link");
    preconnect2.rel = "preconnect";
    preconnect2.href = "https://fonts.gstatic.com";
    preconnect2.crossOrigin = "anonymous";
    preconnect2.setAttribute("data-gfont", "");
    document.head.appendChild(preconnect2);

    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = FONT_HREF;
    stylesheet.setAttribute("data-gfont", "");
    document.head.appendChild(stylesheet);
  }

  const REDUCED_MOTION =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function slidePill(pill, targetPercent) {
    if (!pill) return;
    if (pill._springRaf) cancelAnimationFrame(pill._springRaf);

    // First positioning: snap (avoid an initial setup animation).
    if (pill._currentX === undefined) {
      pill.style.transform = "translateX(" + targetPercent + "%)";
      pill._currentX = targetPercent;
      pill._springRaf = null;
      return;
    }

    // Reduced motion: snap to target.
    if (REDUCED_MOTION) {
      pill.style.transform = "translateX(" + targetPercent + "%)";
      pill._currentX = targetPercent;
      pill._springRaf = null;
      return;
    }

    const start = pill._currentX;
    if (Math.abs(targetPercent - start) < 0.05) {
      pill.style.transform = "translateX(" + targetPercent + "%)";
      pill._currentX = targetPercent;
      pill._springRaf = null;
      return;
    }

    // Critical damping (damping ratio = 1.0). Force = -omega^2 (x - target)
    // - 2 * omega * v. With omega = 1 / response, this settles with no
    // overshoot and carries velocity through re-targets.
    const omega = 1 / 0.35;
    let value = start;
    let velocity = pill._velocity || 0;
    let lastTime = performance.now();

    function step(now) {
      const dt = Math.min((now - lastTime) / 1000, 1 / 30); // clamp big gaps
      lastTime = now;
      const acceleration =
        -omega * omega * (value - targetPercent) - 2 * omega * velocity;
      velocity += acceleration * dt;
      value += velocity * dt;
      pill.style.transform = "translateX(" + value + "%)";
      if (
        Math.abs(value - targetPercent) > 0.05 ||
        Math.abs(velocity) > 0.05
      ) {
        pill._springRaf = requestAnimationFrame(step);
      } else {
        pill.style.transform = "translateX(" + targetPercent + "%)";
        pill._currentX = targetPercent;
        pill._velocity = 0;
        pill._springRaf = null;
      }
    }

    pill._springRaf = requestAnimationFrame(step);
  }

  // Expose on window so the inline <head> bootstrap and the page scripts
  // can both use them without an import system.
  window.loadBlueprintFonts = loadBlueprintFonts;
  window.slidePill = slidePill;
})();