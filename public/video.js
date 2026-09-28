// The big play button covers the poster until the film starts; after that the
// browser's own controls take over. Without this script the controls simply
// show from the start.
const frame = document.querySelector(".player-frame");
const film = frame?.querySelector("video");
const start = frame?.querySelector(".player-start");
if (frame && film && start) {
  film.controls = false;
  const begin = () => {
    frame.classList.add("is-playing");
    film.controls = true;
  };
  start.addEventListener("click", () => {
    begin();
    film.play().catch(() => {});
    film.focus();
  });
  film.addEventListener("play", begin);
}
