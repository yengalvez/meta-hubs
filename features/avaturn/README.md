# Carga privada de avatares GLB

## Estado

La carga privada y su interfaz neutral están incluidas en la fuente Hubs
`b2697e7` del build `33245207737`, cuya imagen se desplegó durante Sitting v2
(evidencia en `docs/session-changelog.md`). No hace falta otro despliegue solo
para publicar el renombrado. La aceptación específica de subida, persistencia
y aislamiento entre cuentas sigue pendiente en `PLAN_ACTUAL.md`.

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

## Investigación histórica

La investigación inicial, ejemplos de iframe y documentos extensos previos a
la implementación están archivados en `OLD/features/avaturn-research/`. No
forman parte del flujo vigente. No debe reactivarse un iframe o API de proveedor
sin superar las puertas de la evaluación de julio de 2026.
