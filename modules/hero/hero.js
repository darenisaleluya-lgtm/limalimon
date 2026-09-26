import { HERO_CONFIG } from "./hero.config.js";

let timerId = null;

const pad = (value) => String(Math.max(0, value)).padStart(2, "0");

function getElements(root) {
  return {
    phrase: root.querySelector("#hero-phrase"),
    image: root.querySelector(".hero__image"),
    eyebrow: root.querySelector(".countdown__eyebrow"),
    intro: root.querySelector(".countdown__intro"),
    dateLabel: root.querySelector("#countdown-date-label"),
    days: root.querySelector("#countdown-days"),
    hours: root.querySelector("#countdown-hours"),
    minutes: root.querySelector("#countdown-minutes"),
    seconds: root.querySelector("#countdown-seconds"),
    status: root.querySelector("#countdown-status"),
    countdown: root.querySelector(".countdown"),
  };
}

function paintCountdown(elements, differenceMs) {
  const totalSeconds = Math.max(0, Math.floor(differenceMs / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  elements.days.textContent = pad(days);
  elements.hours.textContent = pad(hours);
  elements.minutes.textContent = pad(minutes);
  elements.seconds.textContent = pad(seconds);
}

function startCountdown(elements) {
  const target = new Date(HERO_CONFIG.eventStart);

  if (Number.isNaN(target.getTime())) {
    elements.status.textContent = "Revisa la fecha configurada del evento.";
    return;
  }

  const tick = () => {
    const remaining = target.getTime() - Date.now();

    if (remaining <= 0) {
      paintCountdown(elements, 0);
      elements.status.textContent = HERO_CONFIG.startedMessage;
      elements.countdown.classList.add("countdown--started");
      if (timerId) window.clearInterval(timerId);
      timerId = null;
      return;
    }

    paintCountdown(elements, remaining);
    elements.status.textContent = "";
  };

  tick();
  timerId = window.setInterval(tick, 1000);
}

export function mountHero() {
  const root = document.querySelector("#hero-module");
  if (!root) return () => {};

  const elements = getElements(root);

  elements.phrase.textContent = HERO_CONFIG.phrase;
  elements.eyebrow.textContent = HERO_CONFIG.countdownEyebrow;
  elements.intro.textContent = HERO_CONFIG.countdownIntro;
  elements.dateLabel.textContent = HERO_CONFIG.eventDateLabel;
  root.style.setProperty("--hero-position-x", HERO_CONFIG.imagePositionX);
  root.style.setProperty("--hero-position-y", HERO_CONFIG.imagePositionY);
  root.setAttribute("data-event-title", HERO_CONFIG.eventTitle);

  startCountdown(elements);

  return function unmountHero() {
    if (timerId) window.clearInterval(timerId);
    timerId = null;
  };
}
