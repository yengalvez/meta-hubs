# Carga privada de avatares GLB

## Estado

La carga privada y su interfaz neutral están incluidas en la fuente Hubs
`b2697e7` del build `33245207737`, cuya imagen se desplegó durante Sitting v2
(evidencia en `docs/session-changelog.md`). No hace falta otro despliegue solo
para publicar el renombrado. La aceptación específica de subida, persistencia
y aislamiento entre cuentas sigue pendiente en `PLAN_ACTUAL.md`.

El 31 de agosto se reprodujo y corrigió localmente un fallo al cambiar
de archivo: rechazar el nuevo permitía procesar el válido anterior. La nueva
focal del editor pasa 11/11. El 1 de septiembre la candidata quedó congelada en
Hubs `e83adaf38` y pasó una vez la sección oficial: 119 unidades, lint y builds
de Hubs/Admin. La PR Hubs #7 pasó seguridad y su build completo y quedó
fusionada en `master=668413a20`. El gitlink raíz se integró después en
`main=4f3d91a17`; sigue pendiente el build de imagen y el rollout productivo
autorizado.

Ya se obtuvieron por encargo del propietario un ejemplo oficial Avaturn y
Mixamo Xbot: [procedencia, hashes y comprobación local](sample-check-2026-08-31.md).
Ambos cargan con el loader y validadores actuales y ya se ven en los componentes
reales del editor local, con PNG generados y transporte aislado en memoria.
Se corrigió además el encuadre de Xbot. No se han subido ni guardado en servidor.
Su uso se limita a evaluación local; no sustituye integración, permisos de uso
comercial, persistencia o aislamiento entre cuentas.

El flujo permite a un usuario autenticado subir un `.glb` compatible desde el
selector y conservarlo como avatar de su cuenta sin publicarlo en los listados.
Es neutral respecto del proveedor: puede
recibir una exportación de MPFB/MakeHuman, Avaturn, MetaPerson, un antiguo RPM u
otra herramienta, siempre que el archivo pase las validaciones.

El nombre del directorio se conserva como referencia histórica. La decisión de
proveedor y sus puertas de licencia/privacidad están en
[`docs/avatar-provider-evaluation-2026-07.md`](../../docs/avatar-provider-evaluation-2026-07.md).

## Contrato

- Formato: GLB 2.0.
- El cliente valida que exista un skeleton upper-body compatible.
- Preview y skeleton válidos antes de habilitar Guardar. La miniatura se genera
  durante el guardado y debe verse al recargar el avatar guardado.
- El encuadre de la vista previa considera los vértices deformados por el rig
  y las morphs, además del ancho/alto del visor; no confunde escala de bind pose
  con tamaño visible ni recorta las manos por usar solo la altura.
- Elegir otro GLB invalida inmediatamente el anterior mientras se valida;
  un rechazo no permite enviar el previo. Cancelar el selector sin elegir
  conserva el válido, y una validación tardía no sustituye la selección nueva.
- `allow_promotion=false`.
- `allow_remixing=false`.
- El flujo no crea un `avatar_listing`.
- El avatar aparece en `Mis avatares` de su propietario.

La privacidad aqui significa **no listado**. El archivo sigue almacenado en la
instancia Hubs y sujeto a sus permisos y backups.

## Uso

1. Iniciar sesion.
2. Abrir Cambiar avatar.
3. Seleccionar `Subir GLB (privado)`.
4. Elegir el `.glb`.
5. Esperar preview y validacion.
6. Guardar.
7. Seleccionarlo en `Mis avatares`.

La ayuda integrada no promociona un proveedor: recuerda que la licencia y la
privacidad de la herramienta de creación deben revisarse por separado.

## Implementacion

Archivos principales:

- `hubs/src/react-components/media-browser.js`;
- `hubs/src/react-components/avatar-editor.js`;
- `hubs/src/react-components/room/PrivateGlbHelpModal.js`;
- `hubs/src/utils/avatar-glb-utils.js`;
- `hubs/src/utils/avatar-skeleton-utils.js`;
- controles server-side de propiedad, credenciales de ficheros y tamaños en
  Reticulum; no equivalen a una validación completa del rig en servidor.

## Pruebas de regresion

- GLB válido con skeleton compatible, de al menos dos pipelines distintos.
- GLB corrupto, demasiado grande o sin skeleton.
- Seleccionar un GLB válido y después uno rechazado no debe permitir guardar
  por confusión el anterior: bloquear o identificar claramente el conservado.
- Preview antes de Guardar.
- Aparicion en `Mis avatares`.
- Ausencia en Featured y listings publicos.
- Otro usuario no lo recibe en `Mis avatares`.

El guardado real muta DB y storage: crear checkpoint antes de una prueba de
produccion.

### Corrección local de selección (31 de agosto de 2026)

- Baseline upstream conservada: `prod-2026-03-11`; base de trabajo Hubs
  `0781a63091ac3160a1b473504dc655ac0b002735`.
- Archivo productivo de esta corrección: `hubs/src/react-components/avatar-editor.js`;
  prueba añadida: `hubs/test/unit/react-components/avatar-editor-selection.test.js`.
- Sin cambios de schema, API, formato GLB, skeleton admitido, permisos ni
  persistencia. Se conserva el alias `avaturn-private` y el modo no privado.
- Prueba local: `cd hubs && npm run test:unit -- test/unit/react-components/avatar-editor-selection.test.js`.
  Ejecuta el editor montado y los validadores reales con parser/preview/upload
  aislados: no sustituye las pruebas con avatares reales ni el readback de DB.
- Conflicto upstream probable: handler de selección del archivo y montaje del
  campo GLB en el editor. Mantener la invalidación inmediata al resolverlo.
- Rollback: descartar/revertir esta corrección del cliente antes de integrar,
  sin migrar ni restaurar avatares. Para una publicación futura, conservar el
  digest anterior y el procedimiento de rollback de `deployment/README.md`.

### Corrección local de encuadre (31 de agosto de 2026)

- Misma baseline upstream `prod-2026-03-11`; se cambia solo
  `hubs/src/react-components/avatar-preview.js` y se añade
  `hubs/src/utils/avatar-preview-bounds.js`.
- Causa reproducida con Xbot en los componentes reales: `Box3.setFromObject`
  medía la geometría sin skin, 100 veces menor que el avatar visible. Después
  se constató recorte de manos por no tener en cuenta el ancho del visor.
- Se calculan bounds con skin/morphs una vez al encuadrar, no por frame, y la
  cámara incluye los extremos en ambos ejes. No se modifica el GLB, rig,
  almacenamiento ni movimiento en sala.
- Focal añadida `hubs/test/unit/utils/avatar-preview-bounds.test.js`: seis casos
  de skin/transformaciones/morphs/geometría estática y dos de cámara pasan.
  La verificación visual utiliza editor/preview reales con host aislado y
  GLTFLoader directo: no prueba el wrapper/proxy completo de Hubs ni servidor.
- Conflicto upstream probable: `AvatarPreview.resetCamera` y framing. La utilidad
  depende de `SkinnedMesh.boneTransform` de Three r141; revisar esa API al actualizar.
- Rollback: revertir import/cálculo del preview y la utilidad; sin cambios de
  datos. El archivo original del avatar y el contrato de selección se conservan.

## Investigación histórica

La investigación inicial, ejemplos de iframe y documentos extensos previos a
la implementación están archivados en `OLD/features/avaturn-research/`. No
forman parte del flujo vigente. No debe reactivarse un iframe o API de proveedor
sin superar las puertas de la evaluación de julio de 2026.
