/* ============================================================
   ZONA CARIBE · MODULO MENU
   No conoce ni modifica variables internas de otros modulos.
   Comunica la navegación con el evento: zc:menu:navigate
   ============================================================ */

(() => {
  'use strict';

  const trigger = document.getElementById('zc-menu-trigger');
  const menu = document.getElementById('zc-menu');
  const pull = document.getElementById('zc-menu-pull');
  const pullPath = document.getElementById('zc-menu-pull-path');

  if (!trigger || !menu) return;

  const items = [...menu.querySelectorAll('.zc-menu__item')];
  const root = document.documentElement;

  const reduceMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  const canHover = window.matchMedia(
    '(hover: hover) and (pointer: fine)'
  ).matches;

  let open = false;

  let activeItem =
    items.find(item => item.classList.contains('is-active')) ||
    items[0] ||
    null;

  let lastFocused = null;
  let raf = 0;

  let pointerX = 0;
  let pointerY = 0;

  /* ============================================================
     COLORES DE CADA MODULO
     ============================================================ */

  const colorMap = {
    inicio: {
      hex: '#1677c4',
      rgb: '22,119,196'
    },

    agenda: {
      hex: '#28a10f',
      rgb: '40,161,15'
    },

    servicios: {
      hex: '#d2510e',
      rgb: '210,81,14'
    },

    geoubi: {
      hex: '#b81180',
      rgb: '184,17,128'
    }
  };

  /* ============================================================
     CAMBIO DE COLOR DEL MENU
     ============================================================ */

  function applyAccent(key) {
    const color = colorMap[key] || colorMap.inicio;

    root.style.setProperty(
      '--zc-menu-accent',
      color.hex
    );

    root.style.setProperty(
      '--zc-menu-accent-rgb',
      color.rgb
    );
  }

  /* ============================================================
     ELEMENTO ACTIVO
     ============================================================ */

  function setActive(item, { navigate = false } = {}) {

    if (!item) return;

    items.forEach(el => {
      el.classList.toggle(
        'is-active',
        el === item
      );
    });

    activeItem = item;

    const key =
      item.dataset.menuTarget ||
      'inicio';

    applyAccent(key);

    if (navigate) {

      /*
        Evento personalizado.

        Esto permite que Agenda,
        Servicios y GEOUBI
        sigan siendo completamente
        independientes del menú.
      */

      document.dispatchEvent(
        new CustomEvent(
          'zc:menu:navigate',
          {
            detail: {
              module: key
            }
          }
        )
      );

      /*
        IDs previstos para
        cada módulo.
      */

      const knownTargets = {
        inicio:
          '#hero-module',

        agenda:
          '#agenda-module',

        servicios:
          '#servicios-module',

        geoubi:
          '#geoubi-module'
      };

      const target =
        document.querySelector(
          knownTargets[key]
        );

      /*
        Si el módulo existe,
        se le informa que
        ha sido seleccionado.
      */

      if (
        target &&
        key !== 'inicio'
      ) {

        target.dispatchEvent(
          new CustomEvent(
            'zc:module:activate',
            {
              bubbles: true
            }
          )
        );
      }
    }
  }

  /* ============================================================
     ABRIR MENU
     ============================================================ */

  function openMenu() {

    if (open) return;

    open = true;

    lastFocused =
      document.activeElement;

    document.body.classList.add(
      'zc-menu-lock'
    );

    trigger.setAttribute(
      'aria-expanded',
      'true'
    );

    trigger.setAttribute(
      'aria-label',
      'Cerrar menú'
    );

    menu.classList.add(
      'is-open'
    );

    menu.setAttribute(
      'aria-hidden',
      'false'
    );

    applyAccent(
      activeItem?.dataset.menuTarget ||
      'inicio'
    );

    resetMagnet();

    /*
      Después de abrir,
      pone el foco en
      la primera opción.
    */

    const firstFocusable =
      menu.querySelector(
        '.zc-menu__item'
      );

    if (firstFocusable) {

      window.setTimeout(
        () => {

          firstFocusable.focus({
            preventScroll: true
          });

        },

        reduceMotion
          ? 0
          : 330
      );
    }
  }

  /* ============================================================
     CERRAR MENU
     ============================================================ */

  function closeMenu({
    restoreFocus = true
  } = {}) {

    if (!open) return;

    open = false;

    document.body.classList.remove(
      'zc-menu-lock'
    );

    trigger.setAttribute(
      'aria-expanded',
      'false'
    );

    trigger.setAttribute(
      'aria-label',
      'Abrir menú'
    );

    menu.classList.remove(
      'is-open'
    );

    menu.setAttribute(
      'aria-hidden',
      'true'
    );

    if (
      restoreFocus &&
      lastFocused &&
      typeof lastFocused.focus ===
      'function'
    ) {

      window.setTimeout(
        () => {

          lastFocused.focus({
            preventScroll: true
          });

        },

        reduceMotion
          ? 0
          : 120
      );
    }
  }

  /* ============================================================
     ABRIR / CERRAR
     ============================================================ */

  function toggleMenu() {

    open
      ? closeMenu()
      : openMenu();

  }

  /* ============================================================
     ACCESIBILIDAD
     MANTIENE EL FOCO
     DENTRO DEL MENU
     ============================================================ */

  function trapFocus(event) {

    if (
      !open ||
      event.key !== 'Tab'
    ) return;

    const focusable =
      [
        trigger,
        ...items
      ].filter(
        el => !el.disabled
      );

    if (!focusable.length) return;

    const first =
      focusable[0];

    const last =
      focusable[
        focusable.length - 1
      ];

    if (
      event.shiftKey &&
      document.activeElement === first
    ) {

      event.preventDefault();

      last.focus();

    } else if (
      !event.shiftKey &&
      document.activeElement === last
    ) {

      event.preventDefault();

      first.focus();
    }
  }

  /* ============================================================
     BOTON HAMBURGUESA
     ============================================================ */

  trigger.addEventListener(
    'click',
    toggleMenu
  );

  /* ============================================================
     OPCIONES DEL MENU
     ============================================================ */

  items.forEach(item => {

    /*
      Al pasar el mouse,
      cambia suavemente
      el color del menú.
    */

    item.addEventListener(
      'pointerenter',
      () => {

        setActive(item);

      }
    );

    /*
      También cambia
      al navegar con teclado.
    */

    item.addEventListener(
      'focus',
      () => {

        setActive(item);

      }
    );

    /*
      CLICK EN UNA OPCIÓN
    */

    item.addEventListener(
      'click',
      () => {

        setActive(
          item,
          {
            navigate: true
          }
        );

        window.setTimeout(
          () => {

            closeMenu({
              restoreFocus: false
            });

          },

          reduceMotion
            ? 0
            : 170
        );
      }
    );
  });

  /* ============================================================
     CLICK FUERA DEL CONTENIDO
     ============================================================ */

  menu.addEventListener(
    'click',
    event => {

      if (
        event.target === menu
      ) {

        closeMenu();

      }
    }
  );

  /* ============================================================
     TECLA ESC
     ============================================================ */

  document.addEventListener(
    'keydown',
    event => {

      if (
        event.key === 'Escape' &&
        open
      ) {

        event.preventDefault();

        closeMenu();

        return;
      }

      trapFocus(event);
    }
  );

  /* ============================================================
     EFECTO MAGNETICO / GRAVEDAD

     Inspirado en el ejemplo
     donde el menú parece
     ser atraído por el cursor.

     SOLO FUNCIONA:
     - mouse
     - trackpad

     NO SE EJECUTA:
     - celulares táctiles
     ============================================================ */

  function resetMagnet() {

    root.style.setProperty(
      '--zc-menu-trigger-x',
      '0px'
    );

    root.style.setProperty(
      '--zc-menu-trigger-y',
      '0px'
    );

    if (pull) {

      pull.classList.remove(
        'is-active'
      );

    }
  }

  /* ============================================================
     CURVA DEL EFECTO
     ============================================================ */

  function drawPull() {

    raf = 0;

    if (
      !canHover ||
      open ||
      !pull ||
      !pullPath
    ) return;

    const rect =
      trigger.getBoundingClientRect();

    const cx =
      rect.left +
      rect.width / 2;

    const cy =
      rect.top +
      rect.height / 2;

    const dx =
      pointerX - cx;

    const dy =
      pointerY - cy;

    const distance =
      Math.hypot(
        dx,
        dy
      );

    /*
      Radio dentro del cual
      comienza la sensación
      de atracción.
    */

    const zone = 165;

    if (
      distance >= zone
    ) {

      resetMagnet();

      return;
    }

    /*
      Mientras más cerca
      esté el mouse,
      mayor será la fuerza.
    */

    const strength =
      1 -
      (
        distance /
        zone
      );

    /*
      Movimiento del
      botón hamburguesa.
    */

    const tx =
      Math.max(
        -10,
        Math.min(
          18,
          dx *
          strength *
          0.18
        )
      );

    const ty =
      Math.max(
        -10,
        Math.min(
          18,
          dy *
          strength *
          0.18
        )
      );

    root.style.setProperty(
      '--zc-menu-trigger-x',
      `${tx.toFixed(2)}px`
    );

    root.style.setProperty(
      '--zc-menu-trigger-y',
      `${ty.toFixed(2)}px`
    );

    pull.classList.add(
      'is-active'
    );

    /* ==========================================================
       CREACIÓN DE LA CURVA SVG
       ========================================================== */

    const h =
      Math.max(
        600,
        window.innerHeight
      );

    const y =
      Math.max(
        80,
        Math.min(
          h - 80,
          pointerY
        )
      );

    /*
      Convertimos el punto
      del cursor a la escala
      del SVG 0 - 1000.
    */

    const viewY =
      (
        y /
        h
      ) * 1000;

    /*
      Qué tanto sale
      la curva hacia afuera.
    */

    const bulge =
      38 +
      strength * 72;

    const anchor = 150;

    const top =
      Math.max(
        0,
        viewY - anchor
      );

    const bottom =
      Math.min(
        1000,
        viewY + anchor
      );

    const curve = 115;

    /*
      Ruta SVG dinámica.

      Esta es la parte que
      genera el efecto
      de membrana flexible.
    */

    const d = [

      'M0,0',

      'H40',

      `V${top.toFixed(1)}`,

      `C40,${
        (
          top +
          curve * 0.45
        ).toFixed(1)
      } ${
        bulge.toFixed(1)
      },${
        (
          viewY -
          curve * 0.55
        ).toFixed(1)
      } ${
        bulge.toFixed(1)
      },${
        viewY.toFixed(1)
      }`,

      `S40,${
        (
          viewY +
          curve * 0.55
        ).toFixed(1)
      } 40,${
        bottom.toFixed(1)
      }`,

      'V1000',

      'H0Z'

    ].join(' ');

    pullPath.setAttribute(
      'd',
      d
    );
  }

  /* ============================================================
     OPTIMIZACIÓN

     No recalcula la curva
     cientos de veces por segundo.

     requestAnimationFrame
     sincroniza el movimiento
     con la pantalla.
     ============================================================ */

  function requestPullUpdate() {

    if (raf) return;

    raf =
      window.requestAnimationFrame(
        drawPull
      );
  }

  /* ============================================================
     EVENTOS DEL MOUSE
     ============================================================ */

  if (
    canHover &&
    !reduceMotion
  ) {

    window.addEventListener(
      'pointermove',
      event => {

        pointerX =
          event.clientX;

        pointerY =
          event.clientY;

        requestPullUpdate();

      },
      {
        passive: true
      }
    );

    window.addEventListener(
      'pointerleave',
      resetMagnet,
      {
        passive: true
      }
    );

    window.addEventListener(
      'resize',
      resetMagnet,
      {
        passive: true
      }
    );
  }

  /* ============================================================
     ESTADO INICIAL
     ============================================================ */

  setActive(activeItem);

})();