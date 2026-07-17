# Carga privada de avatares GLB

## Estado

La carga privada está implementada en el cliente Hubs actualmente desplegado.
El renombrado neutral descrito aquí está en fuente candidata y todavía no debe
considerarse live. Un usuario autenticado puede
subir un `.glb` compatible desde el selector de avatares y conservarlo como
avatar de su cuenta sin publicarlo en los listados. El flujo es neutral: puede
recibir una exportación de MPFB/MakeHuman, Avaturn, MetaPerson, un antiguo RPM u
otra herramienta, siempre que el archivo pase las validaciones.

El nombre del directorio se conserva como referencia histórica. La decisión de
proveedor y sus puertas de licencia/privacidad están en
[`docs/avatar-provider-evaluation-2026-07.md`](../../docs/avatar-provider-evaluation-2026-07.md).

## Contrato

- Formato: GLB 2.0.
- El cliente valida que exista un skeleton upper-body compatible.
- Se genera preview/thumbnail antes de habilitar Guardar.
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
- validacion server-side en Reticulum.

## Pruebas de regresion

- GLB válido con skeleton compatible, de al menos dos pipelines distintos.
- GLB corrupto, demasiado grande o sin skeleton.
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
