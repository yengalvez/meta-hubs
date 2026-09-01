# Muestras Avaturn y Mixamo — comprobación local

Fecha: 31 de agosto de 2026. Consumidor: G1 de `PLAN_ACTUAL.md`.
El propietario pidió que el agente consiguiera ejemplos públicos de **Avaturn**
y **Mixamo**. No se necesitan fotografías, cuentas nuevas ni archivos personales.

## Procedencia y archivos exactos

Los binarios originales están fuera de Git, en
`/Users/yengalvez/.yenhubs-private/glb-acceptance-20260831/samples/`.
Se descargaron por HTTPS, con tamaño acotado; sus tamaños y Git blob SHA-1
coinciden con los publicados en los repositorios de origen.

| Muestra | Bytes | SHA-256 | Git blob SHA-1 |
| --- | ---: | --- | --- |
| `avaturn-default.glb` | 2629056 | `4b84a158971a4f490ccffa8377502c39eb44a855975df4ecdc8ae390b76a8431` | `95fcf10eb85a60f5a3f889c7b25504beb7c5bf18` |
| `mixamo-xbot.glb` | 2930032 | `002f8d269de68e5dce3d25195caf390d1aa359bbfaae3fcf4c8dc78ec36c3ba5` | `3805d73e7c9cecef16f69dd0b0f1ce649f69c653` |

- Avaturn: `public/default_model.glb`, commit
  `07f646391a200be497d6bd453763b3ca07b32848` de su
  [ejemplo oficial Three.js](https://github.com/avaturn/avaturn-threejs-example/tree/07f646391a200be497d6bd453763b3ca07b32848), enlazado desde su
  [documentación de integración](https://docs.avaturn.me/docs/integration/web/threejs/).
- Mixamo: `examples/models/gltf/Xbot.glb`, commit
  `b6f7fd42487ba75d6e9c11c09c6059daa83a67d7` de
  [Three.js](https://github.com/mrdoob/three.js/blob/b6f7fd42487ba75d6e9c11c09c6059daa83a67d7/examples/models/gltf/Xbot.glb).
  La [PR de incorporación](https://github.com/mrdoob/three.js/pull/18822)
  identifica Mixamo como origen del modelo. Es un GLB ya convertido del ejemplo,
  no una afirmación de que Mixamo exporte GLB directamente.

## Permisos y límite

Se conservan exclusivamente como muestras de evaluación local, sin publicación
de binarios ni uso en el catálogo de clientes. No se da por obtenida una licencia
comercial o de redistribución por el hecho de estar en un repositorio público.

- El repositorio de ejemplo de Avaturn no declara licencia (`license:null` en
  GitHub). Los [términos enlazados por Avaturn](https://docs.google.com/document/d/e/2PACX-1vT5_TR6-MNs29LqI-LLKHvIKHVE0iluuapOpHODGRVDaqyfuCsEgaiE3ZIliI1-FN_-9rxJZ3iVo_jJ/pub)
  exigen atribución y contienen condiciones comerciales y Enterprise para
  integraciones en beneficio de terceros. Esta descarga no resuelve esos
  permisos. Se mantiene la decisión de no integrar su servicio.
- La [FAQ oficial de Adobe](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)
  permite usar personajes/animaciones en proyectos personales y comerciales;
  no se interpreta como permiso para redistribuir el archivo suelto ni como
  aplicación de la licencia MIT de Three.js al modelo. Antes de publicación,
  revisar también los [términos adicionales de Mixamo](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf).

## Resultado observado, no inferido de mocks

Una página temporal servida solo en loopback cargó los bytes originales con el
`GLTFLoader` ya instalado en Hubs, Three r141. Ejecutó las funciones actuales
`validateAvatarGlbFile`, `ensureAvatarMaterial` y `getAvatarSkeletonMetadata`,
sin cambiar sus fuentes. Se comprobó visualmente en el navegador interno.

| Comprobación | Avaturn | Mixamo Xbot |
| --- | --- | --- |
| Cabecera GLB 2.0, tamaño real y límite de 64 MiB | PASS | PASS |
| Meshes con skin / huesos usados | 5 / 52 | 2 / 67 |
| 12 huesos upper-body requeridos / detección full-body | PASS / true | PASS / true |
| Texturas decodificadas / URIs externas | 2 / 0 | 0 / 0 |
| Modelo visible tras encuadre de vértices con skin | Sí | Sí |
| Alto aproximado de los vértices con skin | 1,870 | 1,809 |
| Clips incluidos, no prueba de locomoción Hubs | Ninguno | agree, headShake, idle, run, sad_pose, sneak_pose, walk |

Ambos son de cuerpo completo; no son una aceptación independiente de un archivo
solo upper-body. No hubo errores ni warnings de consola en esta carga local.

**Observación de encuadre:** el primer cálculo genérico `Box3.setFromObject`
dio 0,018 de alto para Xbot y lo dejó fuera del encuadre. Los vértices deformados
por skin dan 1,809; con ese cálculo ambos son visibles, sin modificar los GLB.
Inicialmente solo se corrigió el visor temporal. La comprobación posterior del
editor reprodujo la causa y la resolvió localmente, como se detalla a continuación.

## Bloque autónomo: editor y miniatura reales

Se montaron `AvatarEditor.WrappedComponent` y `AvatarPreview` desde el checkout,
con React, estilos, Three/WebGL, validadores, splitter GLB y snapshot PNG reales.
La página está en `editor-local/` junto al visor privado. Cuenta, transporte,
tema y helpers de host están aislados; `loadGLTF` se adapta al GLTFLoader real
directo, sin proxy, plugins o caché del wrapper de Hubs. Por ello es una prueba
del componente, no de toda la aplicación ni del guardado persistente.

**Reproducción:** Xbot habilitaba Guardar pero la cámara quedaba aproximadamente
en `[0.0113, 0.0206, 0.0171]` y solo se veía un fragmento del modelo. La primera
corrección por skin hizo visible el cuerpo, pero el cálculo solo vertical
recortaba las manos. Se corrigieron bounds y framing según el aspecto del visor.
No se ajustó el test ni el GLB para ocultar el fallo.

**Resultado final observado en navegador interno, sin errores/avisos:**

| Caso | Resultado |
| --- | --- |
| Mixamo Xbot | Preview completo; cámara `[2.2281, 3.0120, 3.3588]`; PNG 720×1280, 85399 bytes y 38861 píxeles no transparentes; miniatura visible. |
| Avaturn | Preview completo; cámara `[2.2383, 3.0627, 3.3652]`; PNG 720×1280, 81788 bytes y 43612 píxeles no transparentes; miniatura visible. |
| GLB corrupto | Mensaje «El archivo no es un GLB 2.0 válido.» y Guardar deshabilitado. |
| GLB de 64 MiB + 1 byte | Mensaje de límite de 64 MiB y Guardar deshabilitado; no se envió. |
| GLB válido serializado sin skin | Enumera los 12 huesos ausentes y deshabilita Guardar. |

Los dos guardados simulados conservaron `allow_promotion=false`,
`allow_remixing=false` y solo claves `gltf/bin/thumbnail`. Los tres negativos
no aumentaron los seis archivos ni los dos registros en memoria. No son
registros de Reticulum ni evidencia de su autorización server-side.

La focal nueva pasó primero seis casos de bounds (skin, padres, estáticos,
morphs absolutas/relativas y target reutilizado) y después los dos casos nuevos
de cámara. Al congelar la candidata, los ocho quedaron cubiertos juntos una
única vez por la sección oficial Hubs, que pasó 119/119 unidades, ESLint y los
builds Hubs/Admin. Los casos de cámara verifican todos los extremos proyectados
con aspecto 200/450 y 720/1280. No hubo actualización de dependencias; el aviso
heredado de Browserslist sigue sin bloquear este foco.

SHA-256 del candidato de encuadre:

- `avatar-preview.js`: `cfbc8b57c272618187b630d648b0c350548d88248b270080fe257665e4927a13`.
- `avatar-preview-bounds.js`: `4e44c378c0e3e1d5d8b983414cab9eec65e864795e5159fa9b4dec3aa4798c9f`.
- `avatar-preview-bounds.test.js`: `7d91da67faf4ed0abb6daa08041603a408e9237d461819437ad8dc24b029cf85`.

## Evidencia reutilizable y lo que sigue pendiente

El visor acotado queda en
`/Users/yengalvez/.yenhubs-private/glb-acceptance-20260831/sample-preview.mjs`.
Su servidor y su pestaña se cierran al terminar; no queda un proceso vigilando.
No hay dependencias nuevas ni peticiones a proveedores desde el visor.

Hashes SHA-256 de las funciones probadas:

- `avatar-glb-utils.js`: `8f9a541907bd95c217c935b4ee34e65e45758208ebf81b299237bc17bb88d002`.
- `avatar-skeleton-utils.js`: `4e614ca583c3b3508007feba10fd62df2e69317ae938dee909434da298d3418c`.
- `avatar-utils.js`: `50d993f9b3d6b5a60e8610428d74199b216bacc82d0f0b1e2963f51b02668ea2`.
- `GLTFLoader.js`: `3372303b5e1baa9bed30eaec0d23444bb54ebd3da5355e3c04d69bae1834211f`.

La evidencia combinada demuestra carga, componente React de editor/preview y
miniatura locales, además del rollout y vestíbulo productivos en escritorio y
móvil; no la integración completa del loader tras guardar, normalización en
sala, privacidad entre cuentas o animaciones con los dos GLB.
Los 11 casos del selector y los ocho de encuadre están incluidos en la sección
oficial verde sobre `e83adaf38`. La PR Hubs #7 pasó también seguridad y el
workflow completo de build y se fusionó en `master=668413a20`. La publicación
posterior no subió ningún GLB de muestra; el acceso productivo se limitó a
rollout, verificación read-only y vestíbulo privado.
