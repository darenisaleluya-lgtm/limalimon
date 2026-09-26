/* ============================================================
   ZONA CARIBE · DATOS DE LA AGENDA
   ------------------------------------------------------------
   ESTE ES EL ÚNICO ARCHIVO QUE DEBES EDITAR PARA AGREGAR,
   QUITAR O CAMBIAR EVENTOS.

   Formato de cada evento:
   {
     id: "identificador-unico",
     fecha: "2026-10-01",   // AAAA-MM-DD
     inicio: "08:00",       // 24 horas
     fin: "08:30",          // 24 horas
     evento: "Nombre del evento",
     salon: "305"           // Si aún no se conoce: "—"
   }

   La interfaz se genera automáticamente.
   Agregar un objeto nuevo NO requiere tocar el HTML ni el CSS.
   ============================================================ */

window.ZC_AGENDA_CONFIG = {
  zonaHoraria: "America/Bogota",
  offsetISO: "-05:00",
  lugar: "CIP Curumaní",

  eventos: [

    /* ========================================================
       1 DE OCTUBRE
       ======================================================== */

    {
      id: "d1-registro",
      fecha: "2026-10-01",
      inicio: "08:00",
      fin: "08:30",
      evento: "Registro y acreditación de participantes",
      salon: "—"
    },

    {
      id: "d1-apertura",
      fecha: "2026-10-01",
      inicio: "08:30",
      fin: "08:55",
      evento: "Instalación y apertura oficial",
      salon: "—"
    },

    {
      id: "d1-cultural",
      fecha: "2026-10-01",
      inicio: "08:55",
      fin: "09:25",
      evento: "Acto cultural: muestra de piloneras",
      salon: "—"
    },

    {
      id: "d1-conferencia-inaugural",
      fecha: "2026-10-01",
      inicio: "09:25",
      fin: "10:00",
      evento:
        "Conferencia inaugural: Del conocimiento al territorio: ciencia, investigación e innovación para el fortalecimiento del sector hortofrutícola y la transformación del campo",
      salon: "—"
    },

    {
      id: "d1-receso",
      fecha: "2026-10-01",
      inicio: "10:00",
      fin: "10:15",
      evento: "Receso – Refrigerio",
      salon: "—"
    },

    {
      id: "d1-feria",
      fecha: "2026-10-01",
      inicio: "10:00",
      fin: "16:00",
      evento: "Feria de emprendedores · programación simultánea",
      salon: "Plazoleta",
      prioridad: 0
    },

    {
      id: "d1-taller-mindfulness",
      fecha: "2026-10-01",
      inicio: "10:15",
      fin: "11:15",
      evento:
        "Taller vivencial: Mindfulness, reflexividad e investigación humanizada: cultivando vocaciones científicas, artísticas y talento semilla",
      salon: "Sala 1"
    },

    {
      id: "d1-cipas",
      fecha: "2026-10-01",
      inicio: "10:15",
      fin: "11:15",
      evento:
        "Salón Tejiendo Saberes y Territorios: experiencias de CIPAS territoriales",
      salon: "Sala 2"
    },

    {
      id: "d1-panel-talento",
      fecha: "2026-10-01",
      inicio: "11:15",
      fin: "12:00",
      evento:
        "Panel Talento Semilla Internacional: Experiencias de Estancias de Investigación",
      salon: "—"
    },

    {
      id: "d1-almuerzo",
      fecha: "2026-10-01",
      inicio: "12:00",
      fin: "14:00",
      evento: "Almuerzo libre",
      salon: "—"
    },

    {
      id: "d1-ponencias",
      fecha: "2026-10-01",
      inicio: "14:00",
      fin: "15:50",
      evento: "Ponencias y pósteres de investigación",
      salon: "—"
    },

    {
      id: "d1-cierre",
      fecha: "2026-10-01",
      inicio: "15:50",
      fin: "16:00",
      evento: "Reconocimiento y cierre del primer día",
      salon: "—"
    },


    /* ========================================================
       2 DE OCTUBRE
       ======================================================== */

    {
      id: "d2-apertura",
      fecha: "2026-10-02",
      inicio: "08:00",
      fin: "08:15",
      evento: "Bienvenida y apertura de la segunda jornada",
      salon: "—"
    },

    {
      id: "d2-conferencia-pescado",
      fecha: "2026-10-02",
      inicio: "08:15",
      fin: "08:55",
      evento:
        "Conferencia: Del residuo al recurso: innovación y emprendimiento para el aprovechamiento integral de los subproductos del procesamiento de pescado",
      salon: "—"
    },

    {
      id: "d2-panel-mujeres",
      fecha: "2026-10-02",
      inicio: "08:55",
      fin: "09:40",
      evento:
        "Panel: Mujeres que transforman la ciencia: liderazgo, investigación e innovación desde los territorios",
      salon: "Sala 1"
    },

    {
      id: "d2-taller-arte",
      fecha: "2026-10-02",
      inicio: "08:55",
      fin: "09:40",
      evento: "Taller: Arte, cultura y literatura para la ciencia",
      salon: "Sala 2"
    },

    {
      id: "d2-receso",
      fecha: "2026-10-02",
      inicio: "09:40",
      fin: "10:00",
      evento: "Receso – Refrigerio",
      salon: "—"
    },

    {
      id: "d2-feria",
      fecha: "2026-10-02",
      inicio: "10:00",
      fin: "12:00",
      evento: "Feria de emprendedores · programación simultánea",
      salon: "Plazoleta",
      prioridad: 0
    },

    {
      id: "d2-ponencias",
      fecha: "2026-10-02",
      inicio: "10:00",
      fin: "11:30",
      evento: "Ponencias y pósteres de investigación",
      salon: "—"
    },

    {
      id: "d2-reconocimiento",
      fecha: "2026-10-02",
      inicio: "11:30",
      fin: "11:45",
      evento:
        "Reconocimiento al Talento Semilla, la Innovación, el Emprendimiento y el Liderazgo Territorial",
      salon: "—"
    },

    {
      id: "d2-clausura",
      fecha: "2026-10-02",
      inicio: "11:45",
      fin: "12:00",
      evento: "Acto de clausura",
      salon: "—"
    }
  ]
};