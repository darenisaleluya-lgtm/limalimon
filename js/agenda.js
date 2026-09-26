(() => {
  'use strict';

  const moduleEl = document.getElementById('agenda-module');
  const listEl = document.getElementById('agenda-list');
  const scrollEl = document.getElementById('agenda-scroll');
  const emptyEl = document.getElementById('agenda-empty');
  const closeBtn = document.getElementById('agenda-close');
  const motionPath = document.getElementById('agenda-motion-line');
  const titleEl = document.getElementById('agenda-title');

  if (!moduleEl || !listEl || !scrollEl || !window.ZC_AGENDA_CONFIG) return;

  const config = window.ZC_AGENDA_CONFIG;
  const events = Array.isArray(config.eventos) ? config.eventos : [];
  const offset = config.offsetISO || '-05:00';
  const fallbackRoom = '303';

  const reduceMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  const finePointer = window.matchMedia(
    '(hover:hover) and (pointer:fine)'
  ).matches;

  const spotlight = {
    label: document.getElementById('agenda-status-label'),
    time: document.getElementById('agenda-status-time'),
    title: document.getElementById('agenda-status-title'),
    room: document.getElementById('agenda-status-room'),
    countdown: document.getElementById('agenda-status-countdown'),
    day: document.getElementById('agenda-orbit-day'),
    month: document.getElementById('agenda-orbit-month'),
    orbit: document.getElementById('agenda-orbit')
  };

  const palette = [
    '#1677c4',
    '#28a10f',
    '#d2510e',
    '#b81180'
  ];

  let refreshTimer = null;
  let countdownTickTimer = null;
  let observer = null;
  let isOpen = false;
  let animationId = 0;

  let pointerY = 500;
  let pointerPull = 0;
  let currentY = 500;
  let currentPull = 0;
  let selectedRef = null;

  const iconClock = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8"></circle>
      <path d="M12 8v4l3 2"></path>
    </svg>`;

  const iconRoom = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 20V7.5A1.5 1.5 0 0 1 7.5 6H18v14"></path>
      <path d="M6 20H4"></path>
      <path d="M14 12h.01"></path>
    </svg>`;

  function dateFor(event, field) {
    return new Date(`${event.fecha}T${event[field]}:00${offset}`);
  }

  function normalizeEvent(event, index) {
    return {
      ...event,
      index,
      startAt: dateFor(event, 'inicio'),
      endAt: dateFor(event, 'fin'),
      prioridad: Number.isFinite(event.prioridad)
        ? event.prioridad
        : 1
    };
  }

  const normalized = events
    .map(normalizeEvent)
    .filter(event =>
      !Number.isNaN(event.startAt.getTime()) &&
      !Number.isNaN(event.endAt.getTime())
    )
    .sort((a, b) =>
      a.startAt - b.startAt ||
      a.endAt - b.endAt ||
      a.index - b.index
    );

  function roomValue(value) {
    return (
      !value ||
      value === '—'
    )
      ? fallbackRoom
      : String(value).trim();
  }

  function formatRoomLabel(value) {
    const room = roomValue(value);

    return /^\d+$/.test(room)
      ? `Salón ${room}`
      : room;
  }

  function formatHour(value) {
    const [h, m] =
      value
        .split(':')
        .map(Number);

    const suffix =
      h >= 12
        ? 'p. m.'
        : 'a. m.';

    const hour =
      h % 12 || 12;

    return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
  }

  function formatRange(event) {
    return `${formatHour(event.inicio)} – ${formatHour(event.fin)}`;
  }

  function getDayParts(dateString) {
    const date =
      new Date(
        `${dateString}T12:00:00${offset}`
      );

    return {
      day:
        new Intl.DateTimeFormat(
          'es-CO',
          {
            day: '2-digit'
          }
        ).format(date),

      month:
        new Intl.DateTimeFormat(
          'es-CO',
          {
            month: 'short'
          }
        )
          .format(date)
          .replace('.', '')
          .toUpperCase()
    };
  }

  function formatDisplayDate(dateString) {
    if (!dateString) {
      return 'Agenda del encuentro';
    }

    const date =
      new Date(
        `${dateString}T12:00:00${offset}`
      );

    const parts =
      new Intl.DateTimeFormat(
        'es-CO',
        {
          day: 'numeric',
          month: 'long'
        }
      ).formatToParts(date);

    const day =
      parts.find(
        part =>
          part.type === 'day'
      )?.value || '';

    const month =
      (
        parts.find(
          part =>
            part.type === 'month'
        )?.value || ''
      ).toLowerCase();

    return `Agenda del ${day} de ${month}`;
  }

  function accentFor(
    event,
    groupIndex = 0
  ) {
    return (
      event.color ||
      palette[
        (
          event.index +
          groupIndex
        ) %
        palette.length
      ]
    );
  }

  function futureEvents(
    now = new Date()
  ) {
    return normalized.filter(
      event =>
        event.endAt > now
    );
  }

  function isCurrent(
    event,
    now = new Date()
  ) {
    return (
      event.startAt <= now &&
      now < event.endAt
    );
  }

  function getDisplayDate(
    items,
    now = new Date()
  ) {
    if (!items.length) {
      return null;
    }

    const current =
      items.find(
        event =>
          isCurrent(
            event,
            now
          )
      );

    if (current) {
      return current.fecha;
    }

    return items[0].fecha;
  }

  function eventsForDisplayDate(
    items,
    displayDate
  ) {
    return items.filter(
      event =>
        event.fecha === displayDate
    );
  }

  function groupEvents(items) {
    const groups = [];
    const map = new Map();

    items.forEach(event => {

      const key =
        `${event.fecha}|${event.inicio}|${event.fin}`;

      if (!map.has(key)) {

        const group = {
          key,

          fecha:
            event.fecha,

          inicio:
            event.inicio,

          fin:
            event.fin,

          startAt:
            event.startAt,

          endAt:
            event.endAt,

          events: []
        };

        map.set(
          key,
          group
        );

        groups.push(
          group
        );
      }

      map
        .get(key)
        .events
        .push(event);
    });

    return groups;
  }

  function countdownMarkup(
    label,
    totalSeconds
  ) {
    const seconds =
      Math.max(
        0,
        totalSeconds
      );

    const displayH =
      Math.floor(
        seconds /
        3600
      );

    const mm =
      Math.floor(
        (
          seconds %
          3600
        ) /
        60
      );

    const ss =
      seconds %
      60;

    return `
      <span class="agenda__count-label">
        ${label}
      </span>

      <span
        class="agenda__count-clock"
        aria-live="polite"
      >
        <span class="tick">
          ${String(displayH).padStart(2, '0')}
        </span>

        <span class="agenda__count-sep">:</span>

        <span class="tick">
          ${String(mm).padStart(2, '0')}
        </span>

        <span class="agenda__count-sep">:</span>

        <span class="tick">
          ${String(ss).padStart(2, '0')}
        </span>
      </span>
    `;
  }

  function installRevealObserver() {

    if (observer) {
      observer.disconnect();
    }

    const slots = [
      ...listEl.querySelectorAll(
        '.agenda__slot'
      )
    ];

    if (!slots.length) {
      return;
    }

    if (
      reduceMotion ||
      !(
        'IntersectionObserver'
        in window
      )
    ) {

      slots.forEach(
        slot =>
          slot.classList.add(
            'is-visible'
          )
      );

      return;
    }

    observer =
      new IntersectionObserver(
        entries => {

          entries.forEach(
            entry => {

              if (
                entry.isIntersecting
              ) {

                entry
                  .target
                  .classList
                  .add(
                    'is-visible'
                  );

                observer.unobserve(
                  entry.target
                );
              }

            }
          );

        },
        {
          root:
            scrollEl,

          threshold:
            0.12,

          rootMargin:
            '0px 0px -6% 0px'
        }
      );

    slots.forEach(
      slot =>
        observer.observe(slot)
    );
  }

  function buildActivity(
    event,
    accent
  ) {

    const row =
      document.createElement(
        'article'
      );

    row.className =
      'agenda-activity';

    row.style.setProperty(
      '--slot-accent',
      accent
    );

    const main =
      document.createElement(
        'div'
      );

    main.className =
      'agenda-activity__main';

    const title =
      document.createElement(
        'h4'
      );

    title.className =
      'agenda-activity__title';

    title.textContent =
      event.evento;

    const meta =
      document.createElement(
        'div'
      );

    meta.className =
      'agenda-activity__meta';

    const timeChip =
      document.createElement(
        'span'
      );

    timeChip.className =
      'agenda-activity__time-chip';

    timeChip.innerHTML =
      `${iconClock}<span>${formatRange(event)}</span>`;

    const room =
      document.createElement(
        'div'
      );

    room.className =
      'agenda-activity__room';

    room.innerHTML =
      `${iconRoom}<span>${formatRoomLabel(event.salon)}</span>`;

    meta.append(
      timeChip,
      room
    );

    main.append(
      title,
      meta
    );

    row.append(
      main
    );

    return row;
  }

  function buildSlot(
    group,
    slotIndex,
    now
  ) {

    const primary =
      group.events[0];

    const accent =
      accentFor(
        primary,
        slotIndex
      );

    const motionModes = [
      'orbit',
      'drift',
      'breathe',
      'glide'
    ];

    const motionMode =
      motionModes[
        slotIndex %
        motionModes.length
      ];

    const slot =
      document.createElement(
        'section'
      );

    slot.className =
      'agenda__slot';

    slot.dataset.key =
      group.key;

    slot.dataset.motion =
      motionMode;

    slot.style.setProperty(
      '--slot-accent',
      accent
    );

    slot.style.setProperty(
      '--orbit-duration',
      `${4.8 + (slotIndex % 4) * 0.55}s`
    );

    slot.style.setProperty(
      '--spark-duration',
      `${2.7 + (slotIndex % 5) * 0.28}s`
    );

    slot.style.setProperty(
      '--trail-duration',
      `${3.8 + (slotIndex % 4) * 0.45}s`
    );

    slot.style.setProperty(
      '--halo-duration',
      `${5.4 + (slotIndex % 3) * 0.6}s`
    );

    slot.style.setProperty(
      '--motion-delay',
      `${(slotIndex % 6) * 0.22}s`
    );

    if (
      group.events.some(
        event =>
          isCurrent(
            event,
            now
          )
      )
    ) {

      slot.classList.add(
        'is-current'
      );
    }

    const track =
      document.createElement(
        'div'
      );

    track.className =
      'agenda__slot__track';

    const node =
      document.createElement(
        'span'
      );

    node.className =
      'agenda__slot__node';

    const halo =
      document.createElement(
        'span'
      );

    halo.className =
      'agenda__slot__halo';

    const orbit =
      document.createElement(
        'span'
      );

    orbit.className =
      'agenda__slot__orbit';

    const spark =
      document.createElement(
        'span'
      );

    spark.className =
      'agenda__slot__spark';

    const trail =
      document.createElement(
        'span'
      );

    trail.className =
      'agenda__slot__trail';

    track.append(
      node,
      halo,
      orbit,
      spark,
      trail
    );

    const activities =
      document.createElement(
        'div'
      );

    activities.className =
      'agenda__slot__activities';

    group.events.forEach(
      (event, index) => {

        activities.appendChild(
          buildActivity(
            event,

            index === 0
              ? accent
              : accentFor(
                  event,
                  index
                )
          )
        );

      }
    );

    slot.append(
      track,
      activities
    );

    return slot;
  }

  function updateSpotlightTitle(
    displayDate
  ) {

    if (titleEl) {

      titleEl.textContent =
        formatDisplayDate(
          displayDate
        );
    }
  }

  function updateSpotlight(
    now,
    items,
    displayDate
  ) {

    updateSpotlightTitle(
      displayDate
    );

    if (!items.length) {

      spotlight.label.textContent =
        'Agenda finalizada';

      spotlight.time.innerHTML =
        `${iconClock}<span>${config.lugar || 'CIP Curumaní'}</span>`;

      spotlight.title.textContent =
        'Gracias por vivir este encuentro con nosotros.';

      spotlight.room.hidden =
        true;

      spotlight.countdown.innerHTML =
        '';

      spotlight.orbit.style.setProperty(
        '--agenda-progress',
        '360deg'
      );

      spotlight.orbit.style.setProperty(
        '--agenda-orbit-color',
        '#28a10f'
      );

      spotlight.day.textContent =
        '✓';

      spotlight.month.textContent =
        'LISTO';

      selectedRef =
        null;

      return;
    }

    const current =
      items
        .filter(
          event =>
            isCurrent(
              event,
              now
            )
        )

        .sort(
          (a, b) =>
            b.prioridad -
              a.prioridad ||
            b.startAt -
              a.startAt
        );

    const selected =
      current[0] ||
      items.find(
        event =>
          event.startAt >
          now
      ) ||
      items[0];

    selectedRef =
      selected;

    const active =
      isCurrent(
        selected,
        now
      );

    const parts =
      getDayParts(
        selected.fecha
      );

    const accent =
      accentFor(
        selected
      );

    spotlight.label.textContent =
      active
        ? 'En curso'
        : 'Lo próximo';

    spotlight.time.innerHTML =
      `${iconClock}<span>${formatRange(selected)}</span>`;

    spotlight.title.textContent =
      selected.evento;

    spotlight.day.textContent =
      parts.day;

    spotlight.month.textContent =
      parts.month;

    spotlight.orbit.style.setProperty(
      '--agenda-orbit-color',
      accent
    );

    spotlight.room.hidden =
      false;

    spotlight.room.innerHTML =
      `${iconRoom}<span>${formatRoomLabel(selected.salon)}</span>`;

    if (active) {

      const elapsed =
        Math.max(
          0,
          now -
            selected.startAt
        );

      const duration =
        Math.max(
          1,
          selected.endAt -
            selected.startAt
        );

      const progress =
        Math.min(
          1,
          elapsed /
            duration
        );

      spotlight.orbit.style.setProperty(
        '--agenda-progress',
        `${
          Math.round(
            progress *
            360
          )
        }deg`
      );

    } else {

      spotlight.orbit.style.setProperty(
        '--agenda-progress',
        '0deg'
      );
    }

    paintSpotlightCountdown(
      now
    );
  }

  function paintSpotlightCountdown(
    now = new Date()
  ) {

    if (!selectedRef) {
      return;
    }

    const active =
      isCurrent(
        selectedRef,
        now
      );

    const diffMs =
      active
        ? selectedRef.endAt - now
        : selectedRef.startAt - now;

    const totalSeconds =
      Math.max(
        0,
        Math.floor(
          diffMs /
          1000
        )
      );

    spotlight.countdown.innerHTML =
      countdownMarkup(
        active
          ? 'Termina en'
          : 'Inicia en',

        totalSeconds
      );
  }

  function render({
    preserveScroll = true
  } = {}) {

    const now =
      new Date();

    const allFuture =
      futureEvents(
        now
      );

    const displayDate =
      getDisplayDate(
        allFuture,
        now
      );

    const items =
      displayDate
        ? eventsForDisplayDate(
            allFuture,
            displayDate
          )
        : [];

    const previousTop =
      scrollEl.scrollTop;

    updateSpotlight(
      now,
      items,
      displayDate
    );

    listEl.replaceChildren();

    if (!items.length) {

      emptyEl.classList.add(
        'is-visible'
      );

      if (
        !preserveScroll
      ) {

        scrollEl.scrollTop =
          0;
      }

      return;
    }

    emptyEl.classList.remove(
      'is-visible'
    );

    const groups =
      groupEvents(
        items
      );

    const fragment =
      document.createDocumentFragment();

    groups.forEach(
      (group, index) => {

        fragment.appendChild(
          buildSlot(
            group,
            index,
            now
          )
        );

      }
    );

    listEl.appendChild(
      fragment
    );

    installRevealObserver();

    if (
      preserveScroll
    ) {

      scrollEl.scrollTop =
        Math.min(
          previousTop,

          scrollEl.scrollHeight -
            scrollEl.clientHeight
        );
    }
  }

  function openAgenda() {

    if (isOpen) {

      render();

      return;
    }

    isOpen =
      true;

    moduleEl.classList.add(
      'is-active'
    );

    moduleEl.setAttribute(
      'aria-hidden',
      'false'
    );

    document.body.classList.add(
      'zc-agenda-open'
    );

    render({
      preserveScroll:
        false
    });

    refreshTimer =
      window.setInterval(
        () =>
          render(),
        30000
      );

    countdownTickTimer =
      window.setInterval(
        () =>
          paintSpotlightCountdown(
            new Date()
          ),
        1000
      );

    startMotionLine();

    window.setTimeout(
      () => {

        scrollEl.focus({
          preventScroll:
            true
        });

      },

      reduceMotion
        ? 0
        : 420
    );
  }

  function closeAgenda() {

    if (!isOpen) {
      return;
    }

    isOpen =
      false;

    moduleEl.classList.remove(
      'is-active'
    );

    moduleEl.setAttribute(
      'aria-hidden',
      'true'
    );

    document.body.classList.remove(
      'zc-agenda-open'
    );

    if (
      refreshTimer
    ) {

      clearInterval(
        refreshTimer
      );

      refreshTimer =
        null;
    }

    if (
      countdownTickTimer
    ) {

      clearInterval(
        countdownTickTimer
      );

      countdownTickTimer =
        null;
    }

    if (
      observer
    ) {

      observer.disconnect();

      observer =
        null;
    }

    stopMotionLine();
  }

  document.addEventListener(
    'zc:menu:navigate',
    event => {

      const target =
        event.detail?.module;

      if (
        target ===
        'agenda'
      ) {

        openAgenda();

      } else {

        closeAgenda();
      }
    }
  );

  moduleEl.addEventListener(
    'zc:module:activate',
    openAgenda
  );

  closeBtn?.addEventListener(
    'click',
    () => {

      const home =
        document.querySelector(
          '.zc-menu__item[data-menu-target="inicio"]'
        );

      if (home) {

        home.click();

      } else {

        closeAgenda();
      }
    }
  );

  function updateMotionLine(
    time = 0
  ) {

    if (
      !isOpen ||
      !motionPath
    ) {

      animationId =
        0;

      return;
    }

    currentY +=
      (
        pointerY -
        currentY
      ) *
      0.075;

    currentPull +=
      (
        pointerPull -
        currentPull
      ) *
      0.08;

    const ambient =
      reduceMotion
        ? 0
        : Math.sin(
            time /
            1700
          ) *
          0.7;

    const x =
      23 +
      currentPull +
      ambient;

    const y =
      Math.max(
        120,

        Math.min(
          880,
          currentY
        )
      );

    const y1 =
      Math.max(
        0,
        y -
          170
      );

    const y2 =
      Math.min(
        1000,
        y +
          170
      );

    motionPath.setAttribute(
      'd',

      `M23 0
       V${y1.toFixed(1)}
       C23 ${(y1 + 68).toFixed(1)}
       ${x.toFixed(1)} ${(y - 72).toFixed(1)}
       ${x.toFixed(1)} ${y.toFixed(1)}
       S23 ${(y + 72).toFixed(1)}
       23 ${y2.toFixed(1)}
       V1000`
    );

    animationId =
      requestAnimationFrame(
        updateMotionLine
      );
  }

  function startMotionLine() {

    if (
      animationId ||
      reduceMotion
    ) {
      return;
    }

    animationId =
      requestAnimationFrame(
        updateMotionLine
      );
  }

  function stopMotionLine() {

    if (
      animationId
    ) {

      cancelAnimationFrame(
        animationId
      );
    }

    animationId =
      0;

    pointerPull =
      0;
  }

  if (
    finePointer
  ) {

    moduleEl.addEventListener(
      'pointermove',
      event => {

        if (
          !isOpen
        ) {
          return;
        }

        pointerY =
          (
            event.clientY /
            Math.max(
              1,
              window.innerHeight
            )
          ) *
          1000;

        const railX =
          window.innerWidth *
          0.15;

        const distance =
          Math.abs(
            event.clientX -
            railX
          );

        const railZone =
          Math.min(
            220,
            window.innerWidth *
              0.30
          );

        const proximity =
          Math.max(
            0,
            1 -
              (
                distance /
                railZone
              )
          );

        const direction =
          event.clientX >=
          railX
            ? 1
            : -1;

        pointerPull =
          proximity *
          3.2 *
          direction;

      },
      {
        passive:
          true
      }
    );

    moduleEl.addEventListener(
      'pointerleave',
      () => {

        pointerPull =
          0;

      },
      {
        passive:
          true
      }
    );
  }

  scrollEl.addEventListener(
    'scroll',
    () => {

      if (
        !isOpen ||
        finePointer
      ) {
        return;
      }

      const max =
        Math.max(
          1,

          scrollEl.scrollHeight -
            scrollEl.clientHeight
        );

      const progress =
        scrollEl.scrollTop /
        max;

      pointerY =
        140 +
        progress *
          720;

      pointerPull =
        Math.sin(
          progress *
          Math.PI
        ) *
        1.8;

    },
    {
      passive:
        true
    }
  );

  document.addEventListener(
    'visibilitychange',
    () => {

      if (
        isOpen &&
        !document.hidden
      ) {

        render();
      }
    }
  );

})();