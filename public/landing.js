// The front page's two motions: sections fade in once as they arrive, and in
// "One Tuesday" the pinned screenshot follows whichever step is in the middle
// of the screen. Both use IntersectionObserver, so nothing runs per scroll frame.

document.documentElement.classList.add("js");

const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.15 },
  );
  reveals.forEach((element) => seen.observe(element));

  const steps = [...document.querySelectorAll(".step")];
  const shots = [...document.querySelectorAll(".stage-frame img")];
  const show = (step) => {
    const index = Number(step.dataset.shot);
    steps.forEach((other) => other.classList.toggle("is-on", other === step));
    shots.forEach((shot, i) => shot.classList.toggle("is-on", i === index));
  };
  if (steps.length) show(steps[0]);
  // A thin band across the middle of the screen: the step crossing it is the current one.
  const current = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) show(entry.target);
    },
    { rootMargin: "-45% 0px -45% 0px" },
  );
  steps.forEach((step) => current.observe(step));
} else {
  reveals.forEach((element) => element.classList.add("in"));
}

// Kaki's loops only play where people can see them and when motion is welcome.
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
for (const video of document.querySelectorAll("video[autoplay]")) {
  if (calm.matches) {
    video.removeAttribute("autoplay");
    video.pause();
  }
}
