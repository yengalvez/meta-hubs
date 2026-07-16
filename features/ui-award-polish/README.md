# UI Obsidian Aurora

## Objetivo

Pulido visual integral del cliente de usuario de YenHubs con una interfaz oscura, legible y consistente sobre la
escena 3D. El trabajo corrige solapes de capas, paneles que quedaban detras de la toolbar, superficies demasiado
transparentes, controles descentrados, acciones duplicadas visualmente y layouts que se degradaban en movil.

Admin y Spoke quedan explicitamente fuera de este rediseño.

## Estado aceptado en produccion

- Commit Hubs: `c679151ed1fb02616bdebf9b32ac65a9b9a4d20e`.
- GitHub Actions: run `29494554300`.
- Imagen: `ghcr.io/yengalvez/hubs@sha256:e61d253ea651280f75800a717cb24f66af35949266cd316402526d520766f103`.
- Version visible en toolbar: bundle `785aa63d`.
- Evidencia visual live: `output/ui-award-audit-20260716/production/`.
- Verificador live: 0 fallos y 0 avisos.

La aceptacion de produccion comprobo home, entrada, sala activa, chat, selector de avatares y movil. Desktop y movil
entran en la sala, cargan cinco bots, no tienen overflow horizontal ni excepciones JavaScript. La portada movil usa
`body` como contenedor de scroll de forma intencionada; se valido con desplazamiento real hasta la tarjeta publica y
el footer, ya que una captura `fullPage` de Chromium no sigue automaticamente ese scroll interno.

## Baseline upstream

- Hubs oficial: `prod-2026-03-11`.
- Commit YenHubs de partida: `cbded5883c79648920a2b78fd1d8372cd0c94d6e`.
- Stack visual: React, CSS Modules/SCSS y los componentes existentes de Hubs. No se introduce otro framework UI.

## Direccion visual

Nombre interno: **Obsidian Aurora**.

- Fondo obsidiana y paneles azul profundo.
- Superficies glass suficientemente opacas para preservar legibilidad.
- Acentos cyan/azul reservados para foco, seleccion y acciones primarias.
- Radios moderados, sombras profundas y brillo controlado.
- Dock compacto dividido por funcion, sin grandes capsulas vacias.
- Jerarquia de capas centralizada mediante tokens `--mv-z-*`.
- Animaciones breves y compatibles con `prefers-reduced-motion`.

## Superficie de personalizacion

### Fundamentos y navegacion

- `hubs/src/react-components/styles/global.scss`
- `hubs/src/assets/stylesheets/ui-root.scss`
- `hubs/src/assets/locales/es.json`
- `hubs/src/react-components/layout/Header.js`
- `hubs/src/react-components/layout/Header.scss`

Se definen tokens visuales, capas, dimensiones comunes, foco accesible y un header responsive que evita partir el
correo o superponer navegacion y cuenta.

### Layout, overlays y capas

- `hubs/src/react-components/layout/RoomLayout.js`
- `hubs/src/react-components/layout/RoomLayout.scss`
- `hubs/src/react-components/layout/Toolbar.scss`
- `hubs/src/react-components/layout/CenteredModalWrapper.scss`
- `hubs/src/react-components/layout/FullscreenLayout.scss`
- `hubs/src/react-components/sidebar/Sidebar.scss`
- `hubs/src/react-components/modal/Modal.scss`
- `hubs/src/react-components/popover/Popover.scss`

La sidebar ocupa su columna y toda la altura disponible. La toolbar queda limitada a la columna de escena, se oculta
durante flujos modales y nunca se renderiza por detras de una sidebar. Fullscreen, popovers, notificaciones y modales
usan una escala de capas unica.

### Controles compartidos

- `hubs/src/react-components/input/Button.scss`
- `hubs/src/react-components/input/IconButton.scss`
- `hubs/src/react-components/input/InputField.scss`
- `hubs/src/react-components/input/TextInput.scss`
- `hubs/src/react-components/input/SelectInputField.scss`
- `hubs/src/react-components/input/ToggleInput.scss`
- `hubs/src/react-components/input/RadioInput.scss`
- `hubs/src/react-components/input/ToolbarButton.scss`

Se unifican tamanos, estados hover/focus/disabled, contraste, radios y alineacion de iconos. Se restauran tambien las
variantes de tamano de `Button` que el componente ya exponia pero no tenian una representacion SCSS completa.

### Interfaz de sala

- `hubs/src/react-components/ui-root.js`
- `hubs/src/react-components/room/ChatSidebar.js`
- `hubs/src/react-components/room/ChatSidebar.scss`
- `hubs/src/react-components/room/BotChatPanel.scss`
- `hubs/src/react-components/room/ContentMenu.scss`
- `hubs/src/react-components/room/MoreMenuPopover.scss`
- `hubs/src/react-components/room/NotificationsContainer.scss`
- `hubs/src/react-components/room/ObjectsSidebar.scss`
- `hubs/src/react-components/room/PeopleSidebar.scss`
- `hubs/src/react-components/room/RoomSidebar.scss`
- `hubs/src/react-components/room/RoomSettingsSidebar.js`
- `hubs/src/react-components/room/RoomSettingsSidebar.scss`
- `hubs/src/react-components/room/RoomEntryModal.scss`
- `hubs/src/react-components/room/Tip.scss`

Incluye dock compacto, badge de version, estado vacio del chat, ajustes de sala estructurados, menu contextual y
notificaciones con contraste suficiente. La accion de enlace de sala se llama `Invitar`; `Compartir` queda reservado
para pantalla/camara y se elimina la ambiguedad visual.

### Selector de contenido y avatares

- `hubs/src/react-components/media-browser.js`
- `hubs/src/react-components/room/MediaBrowser.scss`
- `hubs/src/react-components/room/MediaGrid.scss`
- `hubs/src/react-components/room/MediaTiles.js`
- `hubs/src/react-components/room/MediaTiles.scss`

Las acciones `Crear avatar`, `Subir Avaturn (privado)` y `Guia Avaturn` son tarjetas compactas y diferenciadas, no
tiles altos duplicados que compitan con las previsualizaciones.

## Contratos preservados

- No cambian APIs, schemas de red, store persistido ni contratos backend.
- No cambia el comportamiento de bots, sitting, tercera persona o avatares.
- Admin y Spoke no reciben estilos de esta feature.
- La escena 3D sigue siendo el fondo real de la interfaz de sala.

## Aceptacion obligatoria

1. `npm run check`
2. `npm run lint`
3. `npm run test:unit`
4. `npm run build`
5. Capturas a `1440x900` y `390x844` de:
   - home;
   - entrada y configuracion de audio;
   - sala activa y toolbar;
   - chat/sidebar;
   - selector de avatares.
6. Cero overflow horizontal.
7. La toolbar no invade la sidebar.
8. La escena 3D permanece visible y ningun overlay queda detras de otro.
9. Validacion live tras desplegar la imagen construida por GitHub Actions.

Las capturas de la implementacion inicial se guardan localmente en
`output/ui-award-audit-20260716/local-after/`. La aceptacion del digest desplegado esta en
`output/ui-award-audit-20260716/production/`.

## Riesgos al actualizar Hubs

Los conflictos mas probables estan en `RoomLayout`, `Toolbar`, `UIRoot`, `Header`, `Sidebar`, `Modal`, `Popover` y
`MediaTiles`. Una actualizacion upstream que cambie su markup, breakpoints o CSS Modules debe revisar esta lista antes
de resolver conflictos.

Una compilacion correcta no demuestra compatibilidad visual. Tras cada upgrade hay que repetir la matriz de capturas,
comprobar capas y probar sidebar + toolbar simultaneamente. No se deben copiar ciegamente los SCSS si upstream cambia
la estructura DOM.

## Rollback

1. Volver `OVERRIDE_HUBS_IMAGE` al digest aceptado anterior.
2. Regenerar el manifiesto con `npm run gen-hcce`.
3. Aplicar el `hcce.yaml` verificado sin ediciones manuales.
4. Confirmar rollout, carga fria y version visible en toolbar.
