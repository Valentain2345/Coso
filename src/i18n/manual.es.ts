/** Spanish manual content. Section ids must match the English manual. */
import type { ManualSection } from './manual';

export const manualEs: ManualSection[] = [
  {
    id: 'welcome',
    title: 'Bienvenido a Coso',
    entries: [
      { kind: 'p', text: 'Coso convierte la grabación de una clase en apuntes legibles, en el mismo equipo donde grabas. No se sube nada: el motor de transcripción (Whisper) funciona dentro de la propia aplicación, así que tu audio y tus apuntes nunca salen de esta computadora o teléfono.' },
      { kind: 'img', src: '/manual/img-start.png', alt: 'Pantalla de inicio de Coso con los botones Empezar a grabar e Importar audio' },
      { kind: 'tip', text: 'No necesitas una cuenta. Las únicas veces que Coso se conecta a internet son para descargar el modelo de Whisper una vez, o cuando usas Google Drive a propósito.' },
    ],
  },
  {
    id: 'first',
    title: 'Crea tu primera transcripción',
    entries: [
      { kind: 'p', text: 'Hay dos maneras de llevar audio a Coso.' },
      {
        kind: 'steps',
        items: [
          'Grabar la clase en vivo: presiona el botón naranja grande «Empezar a grabar» y déjalo correr. Puedes pausar y continuar cuando quieras.',
          'Importar un archivo: presiona «Importar audio» (o arrastra el archivo a cualquier parte de la página) y elige una grabación WAV, MP3, M4A, OGG, FLAC o WebM de hasta 4 horas.',
        ],
      },
      { kind: 'gif', src: '/manual/gif-record.gif', alt: 'Comienza la grabación, se mueve la onda en vivo, y Detener y transcribir lleva a la pantalla de progreso' },
      { kind: 'p', text: 'La primera vez que transcribes, Coso descarga el modelo de Whisper (unos 80 MB). Después funciona sin conexión y arranca al instante.' },
      { kind: 'tip', text: 'Graba con el teléfono o grabadora cerca de quien habla. Coso quita el ruido de fondo, pero una señal clara siempre da mejores apuntes.' },
    ],
  },
  {
    id: 'progress',
    title: 'Mientras transcribe',
    entries: [
      { kind: 'img', src: '/manual/img-progress.png', alt: 'Tarjeta de progreso con las cinco etapas: leer el audio, preparar modelos, escribir la transcripción, separar las voces, guardar en el equipo' },
      { kind: 'p', text: 'Las grabaciones largas se procesan en fragmentos de 90 segundos. Tras cada fragmento se guarda el progreso, así que si la laptop se cierra o la pestaña falla, Coso ofrece continuar exactamente donde se quedó — no se pierde nada.' },
      { kind: 'p', text: 'Al terminar, la transcripción se abre sola y queda guardada en la biblioteca de la izquierda.' },
      { kind: 'warn', text: 'Mantén la pestaña abierta mientras trabaja. La transcripción usa tu procesador, y el navegador pausa el trabajo en pestañas de fondo.' },
    ],
  },
  {
    id: 'reading',
    title: 'Lee y busca en tus apuntes',
    entries: [
      { kind: 'img', src: '/manual/img-transcript.png', alt: 'Una transcripción terminada con etiquetas de voz, marcas de tiempo y el cuadro de búsqueda' },
      { kind: 'p', text: 'Cada pasaje muestra quién habló y cuándo. Presiona el ícono de reproducir junto a la marca de tiempo para escuchar ese momento exacto.' },
      {
        kind: 'steps',
        items: [
          'Buscar: presiona el cuadro de búsqueda (o Ctrl + F) para resaltar palabras en toda la transcripción.',
          'Filtrar: con más de una voz, las etiquetas de arriba muestran una voz a la vez.',
          'Copiar: el botón Copiar pone los pasajes visibles en tu portapapeles.',
        ],
      },
      { kind: 'img', src: '/manual/img-sidebar.png', alt: 'La biblioteca de sesiones con varias transcripciones agrupadas por día' },
    ],
  },
  {
    id: 'editing',
    title: 'Corrige una palabra',
    entries: [
      { kind: 'p', text: 'Whisper es bueno, no perfecto — los nombres y las palabras técnicas a veces necesitan una mano.' },
      { kind: 'gif', src: '/manual/gif-edit.gif', alt: 'Abriendo Editar, corrigiendo una palabra de un pasaje y guardando con Enter' },
      {
        kind: 'steps',
        items: [
          'Presiona Editar arriba de la transcripción.',
          'Haz clic en el pasaje que quieres corregir y escríbelo encima.',
          'Presiona Enter para guardar ese pasaje, o Listo para salir del modo de edición.',
        ],
      },
      { kind: 'tip', text: 'Tus cambios se guardan automáticamente en este navegador, junto con el audio.' },
    ],
  },
  {
    id: 'player',
    title: 'Escucha mientras lees',
    entries: [
      { kind: 'img', src: '/manual/img-player.png', alt: 'Barra del reproductor con retroceso, reproducir, avance, forma de onda y control de velocidad' },
      { kind: 'p', text: 'La barra de abajo reproduce la grabación. La forma de onda muestra qué tanto has avanzado; haz clic en cualquier parte para saltar. El pasaje resaltado sigue al audio mientras se reproduce.' },
      {
        kind: 'steps',
        items: [
          'La barra espaciadora reproduce o pausa, y las flechas avanzan o retroceden 5 segundos.',
          'Presiona el botón 1× para cambiar de velocidad: 0.75×, 1×, 1.25×, 1.5× y 2×.',
          'El ícono de descarga guarda el archivo de audio original en tu equipo.',
        ],
      },
    ],
  },
  {
    id: 'export',
    title: 'Exporta tus apuntes',
    entries: [
      { kind: 'gif', src: '/manual/gif-export.gif', alt: 'Abriendo el menú Exportar y eligiendo un formato' },
      { kind: 'p', text: 'El botón Exportar ofrece todos los formatos que puedes necesitar:' },
      {
        kind: 'steps',
        items: [
          'Documento Word — apuntes con formato para editar e imprimir.',
          'PDF — listo para imprimir o compartir.',
          'Texto sin formato y Markdown — para pegar en cualquier parte.',
          'Subtítulos (SRT/VTT) — para subtitular el video de la clase.',
          'Datos estructurados (JSON) — con marcas de tiempo exactas para otras herramientas.',
          'Audio original — la grabación misma, como archivo.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Los ajustes, explicados',
    entries: [
      { kind: 'p', text: 'Abre Ajustes con el ícono del engranaje (o Ctrl + coma). Cada opción se guarda automáticamente.' },
      { kind: 'img', src: '/manual/img-settings-model.png', alt: 'Ajustes, sección Modelo de voz con modelo, idioma hablado y descarga sin conexión' },
      {
        kind: 'steps',
        items: [
          'Modelo de voz — los modelos grandes entienden audio difícil pero descargan más y corren más lento. Whisper Base es un buen valor por defecto; Whisper Large v3 Turbo es el más preciso.',
          'Idioma hablado — elige el idioma de la clase, o deja Inglés y deja que Whisper lo detecte.',
          'Procesamiento — «Separar las voces» etiqueta cada voz (Voz 1, Voz 2…). «Quitar el ruido de fondo» limpia el ruido de la sala; Neuronal es la opción de cada día.',
          'Lectura — tema y tamaño de texto para leer cómodo.',
          'Idioma de la aplicación — cambia toda la interfaz entre inglés y español; el cambio es inmediato y se guarda.',
        ],
      },
      { kind: 'img', src: '/manual/img-settings-processing.png', alt: 'Ajustes, sección Procesamiento con precisión de voces, modelo de voces y eliminación de ruido' },
      { kind: 'tip', text: 'Presiona «Descargar para usar sin conexión» una vez, antes de una semana de exámenes, y Coso funcionará en un avión o en un salón sin señal.' },
      { kind: 'gif', src: '/manual/gif-language.gif', alt: 'Cambiar el idioma de la aplicación de English a Español en Ajustes, con la interfaz cambiando al instante' },
      { kind: 'img', src: '/manual/img-settings-reading.png', alt: 'Ajustes, sección Lectura con tema, tamaño del texto e idioma de la aplicación' },
    ],
  },
  {
    id: 'drive',
    title: 'Copia de seguridad con Google Drive',
    entries: [
      { kind: 'img', src: '/manual/img-drive.png', alt: 'Diálogo de Google Drive con el botón Continuar con Google' },
      { kind: 'p', text: 'Coso nunca sube nada por su cuenta. Al abrir el ícono de la nube, puedes iniciar sesión con Google y elegir subir la grabación abierta, o importar audio que ya esté en tu Drive.' },
      {
        kind: 'steps',
        items: [
          'Presiona Continuar con Google e inicia sesión en la página de Google — Coso nunca ve tu contraseña.',
          'Subir envía la grabación abierta a la carpeta «Coso Audio» de tu Drive.',
          'Importar muestra los archivos de audio de tu Drive para transcribirlos en este equipo.',
        ],
      },
      { kind: 'warn', text: 'Solo las grabaciones que tú elijas subir salen de este equipo. Todo lo demás se queda local.' },
    ],
  },
  {
    id: 'offline',
    title: 'Instalar y usar sin conexión',
    entries: [
      { kind: 'p', text: 'Coso es una aplicación web que puede vivir en tu computadora como un programa normal.' },
      {
        kind: 'steps',
        items: [
          'En Chrome o Edge, abre la dirección de Coso y busca el ícono de instalar en la barra de direcciones (o menú → «Instalar aplicación»).',
          'En un teléfono, abre el menú del navegador y elige «Agregar a la pantalla de inicio».',
          'Después de instalarla, Coso se abre en su propia ventana, funciona sin conexión y conserva tu biblioteca.',
        ],
      },
      { kind: 'tip', text: 'Descarga primero el modelo de voz (Ajustes → «Descargar para usar sin conexión»); después no hace falta internet para nada.' },
    ],
  },
  {
    id: 'phone',
    title: 'Usar Coso en el teléfono',
    entries: [
      { kind: 'img', src: '/manual/img-phone.png', alt: 'Coso en un teléfono, con el botón de grabar y el cajón de la biblioteca' },
      { kind: 'p', text: 'En pantallas pequeñas la biblioteca se convierte en un cajón: el botón de menú de arriba lo abre, y lo cierras deslizándolo a un lado o tocando la página.' },
      { kind: 'img', src: '/manual/img-phone-drawer.png', alt: 'El cajón de la biblioteca abierto en el teléfono, con las sesiones recientes sobre una página atenuada' },
      {
        kind: 'steps',
        items: [
          'Graba la clase con el botón naranja — el teléfono pide permiso de micrófono la primera vez.',
          'Los botones grandes están hechos para los pulgares, y el reproductor queda abajo.',
          'Todo lo que grabes se guarda en el teléfono; expórtalo o respáldalo en Drive desde ahí.',
        ],
      },
      { kind: 'warn', text: 'Transcribir una clase completa en un teléfono es más lento que en una computadora. Para grabaciones largas prefiere la computadora y deja el teléfono para notas rápidas.' },
    ],
  },
  {
    id: 'help',
    title: 'Si algo sale mal',
    entries: [
      {
        kind: 'steps',
        items: [
          '«No terminó» — presiona Intentar de nuevo. Coso continúa desde el último fragmento guardado, así que se pierde poco tiempo.',
          'Falta de memoria o muy lento — elige un modelo más pequeño (Whisper Tiny o Base) en Ajustes, o desactiva la separación de voces Minuciosa.',
          'Sin micrófono — revisa que el navegador tenga permiso (ícono del candado en la barra de direcciones) y que ninguna otra app esté usando el micrófono.',
          'Idioma equivocado en la transcripción — fija «Idioma hablado» en Ajustes en lugar de la detección automática.',
          'Un pasaje está mal — corrígelo con Editar; las correcciones quedan guardadas.',
        ],
      },
      { kind: 'tip', text: 'Todo se guarda en este navegador. Borrar los datos del navegador borra tu biblioteca — exporta lo que quieras conservar primero.' },
    ],
  },
];
