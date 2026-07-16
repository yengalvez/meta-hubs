# Landing Obsidian Aurora

## Objetivo

Esta personalizacion sustituye la portada generica de Hubs por una landing de producto coherente con la interfaz
Obsidian Aurora de YenHubs. La logica de autenticacion, creacion de salas, instalacion PWA, favoritos y salas publicas
se conserva; el cambio es de estructura de presentacion, jerarquia visual y contenido localizado.

## Baseline upstream

- Hubs Foundation: `prod-2026-03-11`
- Baseline YenHubs anterior: commit `c679151ed`
- Rama de implementacion: `codex/landing-aurora-portal`
- Commit de la feature: `1f569385d`
- GitHub Actions: `29499784485`
- Imagen aceptada en el rollout de la feature:
  `ghcr.io/yengalvez/hubs@sha256:b568a9c8565f7983018c2a72d9e13b7bdb32b552381b79a32fdc904bc5e0097c`

La imagen live posterior que conserva esta landing es:
`ghcr.io/yengalvez/hubs@sha256:cff099ef4759c8ec8e8d6010ae9268c6b6e99f29ff5ecb50f6e50ce884d20a8c`.

## Superficie personalizada

Archivos del cliente Hubs:

- `src/react-components/home/HomePage.js`
- `src/react-components/home/HomePage.scss`
- `src/react-components/layout/Header.scss`
- `src/react-components/layout/Footer.js`
- `src/react-components/layout/Footer.scss`
- `src/react-components/banner/Banner.scss`
- `src/assets/locales/es.json`

Contratos conservados:

- `CreateRoomButton` sigue usando `createAndRedirectToNewHub`.
- `SignInButton` y la sesion existente mantienen sus rutas y callbacks.
- `usePublicRooms` y `useFavoriteRooms` siguen siendo las fuentes de datos.
- `MediaTile` sigue renderizando y enlazando las salas.
- `home_background` sigue siendo la imagen configurable, con fallback local.

## Decisiones de diseno

- Hero editorial con CTA principal y un portal visual que reutiliza la captura configurada.
- Ventajas funcionales visibles aunque `show_feature_panels` este desactivado.
- Superficies oscuras, cyan/azul, bordes finos y profundidad compatible con Obsidian Aurora.
- Header, footer y banner reciben estilos especiales solo cuando `body.is-home-page` esta activo.
- En movil se oculta el header de escritorio y se conserva `MobileNav`.
- La pagina mantiene el scroll interno de `body` que usa Hubs; no debe convertirse en un segundo scroll dentro de
  `main`.
- Los logos configurados que fallen al cargar se ocultan en lugar de mostrar un icono roto.

## Auditoria para futuras actualizaciones

Revisar especialmente si upstream cambia:

1. La estructura `Page -> Header -> main -> Footer` o el orden flex de `Page.scss`.
2. El uso de `body` como contenedor de scroll en paginas 2D.
3. Los contratos de `CreateRoomButton`, `MediaTile`, `usePublicRooms` o `useFavoriteRooms`.
4. El montaje de `MobileNav` dentro de `main`.
5. El formato de `home_background`, `AppLogo` o las claves de localizacion.

Un merge que compile no es suficiente. Hay que confirmar que:

- no se duplica el header en movil;
- no hay scroll horizontal en 390, 1024 y 1440 px;
- hero, capacidades, salas, CTA final y footer son alcanzables mediante el scroll real de `body`;
- salas publicas y favoritas siguen abriendo su URL;
- crear sala y autenticacion conservan su comportamiento;
- la portada no cambia Admin, Spoke ni el canvas de las salas.

## Validacion

Comandos minimos:

```bash
npm run check
npm run lint:js
BASE_ASSETS_PATH=https://assets.meta-hubs.org/hubs/ \
RETICULUM_SERVER=meta-hubs.org \
npm run build
```

QA visual:

- Escritorio: `1440x900`
- Tablet: `1024x1366`
- Movil: `390x844`
- Comprobar `body.scrollWidth === body.clientWidth`.
- Revisar consola sin excepciones de React o Sass.
- En local, la busqueda de salas puede fallar por CORS al usar `localhost`; la aceptacion definitiva debe hacerse en
  `https://meta-hubs.org`.

Capturas de la aceptacion live:

- `output/playwright/landing-aurora-production/desktop-top.png`
- `output/playwright/landing-aurora-production/desktop-rooms.png`
- `output/playwright/landing-aurora-production/mobile-top.png`
- `output/playwright/landing-aurora-production/mobile-bottom.png`

## Rollback

La personalizacion no introduce datos persistidos ni APIs nuevas. El rollback consiste en volver al digest Hubs
anterior, regenerar `hcce.yaml`, revisar el diff, aplicar el manifiesto y reiniciar Reticulum para regenerar el HTML y
los hashes CSP.
