# Especificación de experiencia Web: navegación y trabajo operativo

Estado: propuesta de implementación. Base inspeccionada: `apps/web` en `feat/web-information-architecture`, derivada de `hotfix/web-diagram-repairs`. Esta especificación describe el comportamiento objetivo; la interfaz actual sigue vigente hasta que cada fase supere sus criterios de aceptación.

## 1. Problema, usuarios y resultado

AKP es una consola de operación para personas que buscan contexto, revisan propuestas, administran espacios y diagnostican ingestas. La interfaz debe permitir completar esas tareas conservando la autoridad de las fuentes, el alcance del usuario y el estado de revisión. Su modo es **operar**: escaneo rápido, decisiones informadas y acciones verificables tienen prioridad sobre decoración.

La navegación actual de `app/layout.tsx` coloca 18 enlaces, entre ellos la acción «Nueva ingesta», al mismo nivel. En escritorio ocupa una columna permanente de 250 px; en móvil envuelve todos los enlaces en varias filas antes del contenido. No indica la sección activa ni distingue tareas de administración. `app/page.tsx` abre con seis tarjetas numéricas y después varias cuadrículas, incluso cuando están vacías; las revisiones y alertas que requieren acción aparecen diluidas. La captura de referencia del 23-09-2026 a 1280 y 390 px confirmó esta jerarquía. El problema principal es de organización y prioridad, no de paleta.

| Antes                                                     | Después                                                                      | Por qué                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 18 enlaces, incluida «Nueva ingesta», en una lista plana  | Cuatro áreas estables y navegación secundaria contextual                     | Reduce decisiones simultáneas y separa destinos de acciones. |
| «Workspace Home», «Authoring», «Team Admin», «Connectors» | Rótulos de navegación en español orientados a tarea                          | Permite reconocer el destino sin traducir jerga interna.     |
| Seis métricas del mismo peso al inicio                    | Cola de trabajo y alertas accionables primero; indicadores compactos después | Muestra qué requiere intervención y por qué.                 |
| Todos los enlaces ocupan varias filas en móvil            | Cabecera compacta, búsqueda y menú desplegable con foco controlado           | El trabajo empieza visible y la navegación sigue disponible. |
| Tarjetas grandes, incluso vacías, con listas largas       | Filas densas, estados vacíos específicos y enlaces de «ver todo»             | Aprovecha el espacio y evita scroll sin información.         |

**Resultado medible:** una persona puede llegar desde cualquier vista a búsqueda, revisiones, fuentes o administración en un máximo de dos activaciones; desde el inicio identifica el siguiente trabajo pendiente sin interpretar seis contadores. La ubicación y el estado de cada vista son perceptibles por texto, foco y semántica, no sólo por color.

## 2. Principios de decisión

1. **El objeto y la tarea gobiernan la estructura.** «Revisar propuesta», «buscar evidencia», «seguir ingesta» y «diagnosticar» son conceptos de primer nivel. Grafo, evaluaciones y perfiles siguen accesibles donde apoyan esas tareas.
2. **La autoridad nunca se confunde.** Distinguir fuente externa, conocimiento aprobado, borrador en revisión y estado derivado. No presentar un resultado de búsqueda, score o grafo como conocimiento aprobado.
3. **Reconocer antes que recordar.** Etiquetas visibles, ruta actual, migas de pan y acciones cercanas al objeto. No usar una barra de iconos sin texto ni un lanzador de comandos como única navegación.
4. **Mostrar complejidad cuando corresponde.** Configuración, salud y auditoría se agrupan en Administración; los enlaces contextuales aparecen en la tarea pertinente. La información no se elimina ni se esconde detrás de permisos supuestos.
5. **Estado sobre estética.** Cada control comunica carga, vacío, error, permiso insuficiente y éxito cuando aplica. Una alerta incluye gravedad, objeto, causa visible y acción o siguiente paso.
6. **Menos componentes decorativos.** Evitar tarjetas anidadas, métricas sin acción, gradientes, iconos genéricos y animaciones continuas. La identidad visual debe venir de tipografía, espaciado, alineación y tratamiento claro de evidencia y estados.

## 3. Arquitectura de información objetivo

Conservar las rutas y enlaces profundos actuales. El cambio es de presentación y agrupación; no implica renombrar URLs ni contratos de API.

| Área primaria      | Entrada y destinos secundarios                                                                                                                                                            | Acción contextual                                              | Regla de ubicación                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trabajo**        | `/` Inicio; `/reviews` Revisiones; `/decisions` Decisiones                                                                                                                                | Crear conocimiento → `/author` cuando proceda                  | Inicio muestra trabajo pendiente, actividad y alertas; los objetos `/work/:id`, `/services/:id`, `/sessions/:id` y `/reviews/:id` heredan esta área.  |
| **Conocimiento**   | `/search` Buscar; `/sources` Fuentes; `/graph` Grafo                                                                                                                                      | Ingresar fuente → `/ingest`; Proponer conocimiento → `/author` | `/sources/:id`, `/documents/:id` y `/knowledge/:id` mantienen contexto y procedencia. Grafo es una vista de exploración, no una promesa de autoridad. |
| **Procesos**       | `/jobs` Ingestas y trabajos; `/evals` Evaluaciones                                                                                                                                        | Nueva ingesta → `/ingest`                                      | Diferenciar el envío de una ingesta de su seguimiento. `/jobs/:id` conserva esta área.                                                                |
| **Administración** | `/admin/team` Equipo; `/admin/spaces` Espacios; `/admin/profiles` Perfiles; `/admin/connectors` Conectores; `/admin/assurance` Assurance; `/admin/health` Salud; `/admin/audit` Auditoría | Ninguna acción global                                          | Destinos menos frecuentes aparecen sólo al entrar en Administración; cada uno conserva enlace directo y su título.                                    |
| **Sesión**         | `/login` Acceso / sesión                                                                                                                                                                  | Cerrar sesión sólo si existe flujo soportado                   | En cabecera, separada de la navegación de producto. No inferir identidad ni rol de una cookie opaca.                                                  |

**Precisión de rutas:** `/author` y `/ingest` son páginas de trabajo completas, aunque se descubran como acciones; también deben figurar en la navegación secundaria de sus áreas para acceso repetido. `/admin/assurance` atiende hallazgos; `/admin/health` diagnostica estado operativo. No fusionarlas bajo una sola etiqueta ambigua. `ROUTES.md` es el inventario de referencia para las rutas implementadas; el mapa anterior incluye además `/admin/connectors`, presente en código.

**Alcance y permisos:** la navegación no concede ni predice acceso. Hasta disponer de una respuesta de capacidades autorizadas para la sesión, mantener los destinos visibles y dejar que el servidor aplique el alcance; mostrar estado de permiso insuficiente sin revelar objetos. Si posteriormente se filtran destinos por permisos, hacerlo sólo con datos del servidor y conservar una explicación accesible. Nunca guardar tokens en `localStorage`, query strings o HTML renderizado.

## 4. Shell e interacción

### Escritorio, ancho útil ≥ 1024 px

- Cabecera de una fila: marca «AKP» con enlace a Inicio, contexto activo de espacio/vault **sólo si la API lo provee con autoridad**, acceso a Buscar y control de sesión. No inventar selector funcional; un selector futuro necesita fuente de datos y cambio de alcance atómico.
- Navegación primaria persistente con cuatro áreas rotuladas: Trabajo, Conocimiento, Procesos y Administración. Mantener texto visible y `aria-current="page"` para el destino exacto; el área padre puede indicar sección actual por estilo y etiqueta accesible.
- Al seleccionar un área, mostrar sólo su navegación secundaria. La sección activa se deriva de `pathname`, incluidas rutas de detalle. No exigir un clic extra para el destino principal de uso frecuente: Inicio, Buscar, Revisiones y Fuentes deben ser enlaces directos desde cualquier vista mediante la cabecera o la navegación visible.
- Contenido con ancho legible para formularios y lectura; tablas, grafo y comparaciones pueden usar una región ancha. No imponer `width: min(1180px, 100%)` a todos los casos; conservar `min-width: 0` y scroll sólo en la región tabular.
- Encabezado de cada vista: migas de pan, un `h1` de la tarea/objeto, estado relevante y una acción principal como máximo. Acciones destructivas o de gobierno deben estar junto al contexto y pedir confirmación cuando el flujo actual lo requiera.

### Tableta y móvil, ancho < 1024 px

- Cabecera compacta con marca, acceso a Buscar y botón «Abrir navegación». El contenido y su `h1` empiezan antes de la lista completa de destinos.
- Menú como diálogo o panel modal accesible: nombre «Navegación», `aria-expanded` y `aria-controls` en el disparador; al abrir, foco al primer control; Escape y cierre devuelven foco al disparador; al navegar se cierra. Sin scroll del fondo mientras está abierto. No basar la interacción en hover.
- Dentro del panel, cuatro áreas como secciones con títulos y sus enlaces secundarios. Una sección puede estar expandida por defecto según la ruta; todas siguen disponibles por teclado y lector de pantalla.
- A 320 px CSS y zoom de 200 %, el texto refluye, no hay scroll horizontal de documento, los controles no se solapan y ninguna acción queda tapada por cabeceras fijas. Las tablas pueden desplazar horizontalmente dentro de su región con indicación visible.

### Navegación transversal

- Un enlace «Saltar al contenido» enfocable aparece primero y lleva al `main` único. `header`, `nav` y `main` tienen landmarks distinguibles; no dejar varios `main` anidados. Actualmente cada página contiene `main`, así que el shell debe envolver sólo con `div` y preservar ese `main` o migrar todas las páginas de forma coordinada.
- Migas de pan en rutas de detalle: área → lista → objeto. Los nombres privados provienen de la respuesta ya autorizada; mientras cargan, usar una etiqueta genérica («Detalle»). Cada antecesor enlaza a una ruta real. No construir migas con IDs crudos si hay un título autorizado.
- El foco visible se conserva en enlaces, botones, filtros, filas accionables y controles del grafo. Al cambiar de ruta, la cabecera no debe capturar foco inesperadamente; el título o estado de página se anuncia mediante la semántica de Next y el `h1`.
- La búsqueda global lleva a `/search`; no fingir búsqueda instantánea en la cabecera. Si más adelante se implementa, el resultado debe mantener alcance y procedencia.

## 5. Inicio y patrones de contenido

Orden del inicio para una sesión con datos:

1. **Necesita atención:** revisiones pendientes, hallazgos altos, ingestas fallidas o atascadas y degradación de índices. Cada fila: tipo, título comprensible, alcance si está autorizado, gravedad/estado en texto, antigüedad y enlace real. Priorizar por severidad y recencia dentro de cada tipo; no inventar un score transversal. Mostrar hasta cinco filas por grupo y «Ver todo» cuando corresponda.
2. **Trabajo actual:** proyectos, objetos de trabajo y sesiones activas con estado y próxima acción. Mantener enlaces a los objetos, no cifras que compiten por atención.
3. **Estado del sistema:** una línea compacta de frescura/índices, conectores y últimas actualizaciones con acceso a Salud. Un contador aislado no es estado suficiente.
4. **Explorar contexto:** enlaces a Buscar, Fuentes y Grafo, subordinados al trabajo actual.

Cuando no hay trabajo, mostrar un mensaje concreto («No hay revisiones pendientes») y una acción útil («Buscar conocimiento» o «Ver fuentes»); no reservar una tarjeta alta vacía. Con muchos hallazgos, truncar la lista y ofrecer filtro/continuación, nunca renderizar decenas de mensajes largos en el inicio. Si `workspace-home` falla, conservar la navegación y mostrar error recuperable sin imprimir detalles internos o credenciales. La distinción entre «cero» y «no disponible» debe ser explícita.

Patrones comunes para las páginas: encabezado y acción, filtros cerca de la lista, estado de resultado con total y alcance, tabla o lista con filas escaneables, detalle con procedencia y estado. En revisiones y decisiones, presentar impacto y evidencia antes de aprobar/publicar. En búsqueda, conservar señal de conocimiento insuficiente y límites del ContextPacket. En fuentes, separar contenido bruto/derivado del conocimiento aprobado. Los cambios visuales nunca alteran esos límites.

## 6. Accesibilidad y calidad verificable

Objetivo: **WCAG 2.2 nivel AA** para los flujos intervenidos. Aplicar criterios específicos de [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) y sus técnicas de la [guía rápida W3C](https://www.w3.org/WAI/WCAG22/quickref/):

- **Teclado y foco:** 2.1.1 Keyboard, 2.1.2 No Keyboard Trap, 2.4.3 Focus Order, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured (Minimum). Probar menú, búsqueda, navegación secundaria, filtros y acciones sin ratón.
- **Orientación:** 1.3.1 Info and Relationships, 2.4.1 Bypass Blocks, 2.4.2 Page Titled, 2.4.6 Headings and Labels, 3.2.3 Consistent Navigation. Un `h1` de página, `aria-current` y rótulos consistentes.
- **Lectura y selección:** 1.4.3 Contrast (Minimum): 4.5:1 texto normal y 3:1 texto grande; 1.4.11 Non-text Contrast: 3:1 para límites y estados esenciales; 1.4.10 Reflow a 320 px; 2.5.8 Target Size (Minimum): al menos 24 × 24 px o separación/excepción documentada. Objetivo de producto para controles táctiles frecuentes: 44 × 44 px.
- **Estado y errores:** 4.1.3 Status Messages para cambios asíncronos, 3.3.1 Error Identification y 3.3.2 Labels or Instructions para formularios. Un badge no depende sólo del color. Evitar anunciar repetidamente toda la página en cada refresco.
- **Movimiento:** respetar `prefers-reduced-motion`. El menú puede aparecer sin animación; ningún movimiento es necesario para entender estado o jerarquía.

Pruebas de aceptación manuales con teclado y lector de pantalla (NVDA/Windows o equivalente), más comprobación automática con axe donde sea viable. La automatización no sustituye la revisión de orden lógico, nombres accesibles y carga cognitiva.

## 7. Plan de implementación con límites de propiedad

Cada bloque puede ser un cambio revisable independiente. Si participan varias personas o agentes, asignarles archivos distintos y coordinar primero el contrato de navegación; nadie debe revertir cambios concurrentes.

| Bloque                         | Archivos responsables                                                                                    | Entrega y criterio de salida                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Mapa de navegación          | `apps/web/lib/navigation.ts` (nuevo), prueba de mapa; `apps/web/app/layout.tsx`                          | Definir áreas, rótulos y resolución de ruta a sección, incluyendo detalles. Todos los destinos de `ROUTES.md` quedan alcanzables; `/login` no se marca como área de producto.                                  |
| B. Shell adaptable             | Componente nuevo bajo `apps/web/app/` o `apps/web/components/`; `apps/web/app/globals.css`; `layout.tsx` | Cabecera, navegación primaria/secundaria y panel móvil. Teclado, Escape, retorno de foco, skip link, `aria-current`, 320/390/768/1024/1280 px sin solapes. Mantener sesión HttpOnly y comportamiento de login. |
| C. Inicio orientado a atención | `apps/web/app/page.tsx` y estilos específicos                                                            | Reordenar datos existentes de `/v1/operator/workspace-home` sin contrato nuevo. Listas acotadas, vacíos útiles, estado no disponible distinto de cero. Cada alerta enlaza a su flujo real.                     |
| D. Encabezados y detalles      | Rutas de `apps/web/app/` por área; componente compartido para migas                                      | Títulos en español coherentes, migas para detalles, estado y acción primaria. No alterar autorización ni publicación. Dividir por área para evitar conflictos.                                                 |
| E. Validación                  | Pruebas de navegación y shell; capturas desktop/móvil; comprobación manual                               | Rutas clave y estados vacío/lleno/error/permiso, foco, reflow y contraste. Documentar defectos reales antes de cambiar tokens.                                                                                 |

Orden: A → B → C; D puede avanzar por área después de A; E acompaña cada bloque. Antes de integrar, ejecutar `pnpm format:check`, `pnpm contracts:validate`, `pnpm docs:validate`, `pnpm hygiene:validate`, `pnpm check` y `pnpm build`; ejecutar pruebas Web focalizadas y recorrido en navegador. El gate completo del repositorio se ejecuta antes de declarar terminada la reforma. Si un control depende de permisos o datos nuevos, tratarlo como cambio de contrato separado y no simularlo en UI.

## 8. Escenarios de aceptación

1. Desde `/`, una persona abre una revisión pendiente y vuelve a Revisiones; siempre identifica área, ruta y estado de revisión. El acceso a publicar sigue requiriendo el flujo gobernado existente.
2. Desde `/search`, encuentra una fuente, abre `/sources/:id` y distingue evidencia de conocimiento aprobado. La ruta de regreso es visible y el alcance de la consulta no cambia por navegar.
3. Desde `/ingest`, envía una fuente permitida y sigue `/jobs/:id`; error, procesamiento y finalización tienen mensajes distintos. No aparece una ruta de archivo local privada en la navegación o en mensajes no autorizados.
4. Desde una pantalla de 390 px, abre menú con teclado, llega a Auditoría, cierra con Escape y recupera el foco. El contenido principal no queda oculto por la navegación.
5. Un usuario sin autorización para un recurso recibe el estado que devuelve el servidor; la navegación no muestra datos del recurso ni se basa en ocultar enlaces como control de seguridad.
6. Con cero objetos activos, el inicio no presenta una pared de tarjetas vacías. Con más de diez hallazgos, no muestra una lista interminable en la primera vista.
7. A 320 px y zoom 200 %, todas las tareas críticas siguen visibles y operables; a 1280 px el contenido informativo no se pierde en columnas estrechas de tarjetas.

## 9. Decisiones pendientes antes de una expansión de alcance

- Validar con operadores reales las cuatro etiquetas de áreas y los tres recorridos más frecuentes; ajustar rótulos si fallan una prueba de descubrimiento sin ayuda. La estructura propuesta es una hipótesis fundamentada en las rutas y el modelo de producto, no datos de uso medidos.
- Elegir si la selección de espacio/vault pertenece al shell sólo después de identificar una API autorizada y reglas de cambio de alcance. Hasta entonces, mostrar contexto disponible de forma informativa.
- Definir texto y acción de cierre de sesión conforme al contrato existente antes de agregar el control; no sustituir el formulario de token funcional por un cliente dependiente de hidratación.
- Realizar una pasada visual específica tras verificar la nueva estructura. Tipografía, color y microinteracciones se deciden sobre las pantallas reorganizadas, con contraste medido y capturas comparables.

## Referencias de diseño

- [Impeccable, guía de diseño para interfaces](https://github.com/pbakaus/impeccable): criterio de interfaz operativa, jerarquía, auditoría y adaptación.
- [Nielsen Norman Group, progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): mostrar primero decisiones relevantes y revelar opciones secundarias en contexto.
- [W3C, WCAG 2.2](https://www.w3.org/TR/WCAG22/): criterios normativos de accesibilidad citados arriba.
