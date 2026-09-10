# Entrega visual del cliente sin repetir recuperación

Esta vía evita que una reparación de ropa o animación del navegador quede detrás
de horas de pruebas de respaldo. No es una certificación del repositorio completo
ni elimina los respaldos del servicio. Primero probar el cambio localmente; no
usar producción como sustituto del bucle de desarrollo.

## Alcance cerrado

`scripts/client-release-scope.mjs` admite únicamente los módulos de renderizado
enumerados explícitamente y sus tests unitarios. Compara dos SHA completos,
exige candidato limpio en HEAD y rechaza archivos desconocidos, eliminaciones,
symlinks, gitlinks, cambios de dependencias, empaquetado, red y persistencia.
La base debe ser el commit de la imagen Hubs realmente desplegada, no la última
rama local. Verificar ambos digests contra el resultado del build oficial de
GitHub Actions y conservar sus SHA, run ID y digest en el registro de entrega.

Servidor, base de datos, medios, secretos, configuración, infraestructura,
control de acceso o estado de recuperación conservan el circuito completo y el
checkpoint conjunto DB+medios. Si no se puede demostrar el alcance, no usar la
excepción. Cambiar la lista permitida requiere revisión de ese nuevo contrato.

## Pruebas antes de desplegar

```bash
bash scripts/verify-client-release.sh "$DEPLOYED_HUBS_SHA" "$CANDIDATE_HUBS_SHA" run
```

Exige recibos actuales para advisories, Hubs/Admin, browser/capacity y composición;
reutiliza solo los que coinciden en contenido, herramientas y logs privados.
La caché visual predeterminada se separa por versión del ejecutor para no
sobrescribir los recibos de una recuperación antigua que siga en otro checkout.
`check` comprueba lo existente sin lanzar esas secciones. Ejecuta además Gitleaks
del cliente y las pruebas del clasificador. El listado de pruebas de navegador
no constituye aceptación en sala: sigue siendo obligatoria después del rollout.
No exige recovery/H5/security de servidor por un cambio exclusivamente visual.
Las reparaciones del propio aplicador se prueban con `npm run test:apply`,
`npm run test:generator`, sintaxis, límites adversariales y dry-run real antes
de usarlo; no se certifican por el PASS del perfil visual del cliente.

## Comparación y aplicación restringida

Conservar el digest previo y comprobar que sigue disponible para reversión.
Preparar los valores locales privados, cambiar solamente `OVERRIDE_HUBS_IMAGE`
y regenerar el manifiesto con el comando habitual. No imprimir ni editar el
manifiesto generado. En `hubs-cloud/community-edition`, con contexto, perfil de
runtime y rutas privadas ya configurados según README:

```bash
export HCCE_CLIENT_FROM_IMAGE='ghcr.io/yengalvez/hubs@sha256:DIGEST_PREVIO'
export HCCE_CLIENT_TO_IMAGE='ghcr.io/yengalvez/hubs@sha256:DIGEST_NUEVO'
npm run gen-hcce
HCCE_APPLY_PROFILE=client-image-only-check node apply/index.js
HCCE_APPLY_PROFILE=client-image-only npm run apply
```

Los marcadores DIGEST deben sustituirse por los 64 caracteres reales. El modo
`check` hace lecturas y dry-run de servidor, no adquiere Lease ni modifica
recursos persistentes. Un PASS no es autorización durable: la aplicación
repite la comprobación bajo el Lease y justo antes del cambio.

El aplicador exige un runtime ya activo y sin recuperación en curso. Compara
cada recurso generado con su versión viva y con el resultado de dry-run del
manifiesto. Solo permite cambiar el digest del contenedor único `hubs` y la
anotación de inventario de imágenes del Namespace, recalculada desde las imágenes
exactas (perfil legacy). Cualquier otra diferencia significativa aborta.
No aplica de nuevo el resto del manifiesto:
usa una modificación limitada con precondiciones de UID, resourceVersion e
imagen anterior. La anotación derivada lleva su propio CAS y lectura posterior.
Los dos recursos no son una transacción atómica: si falla el segundo, el error
indica que la imagen ya cambió; no dar por completado ni reintentar a ciegas.
Una carrera rechaza la modificación; no hay fallback sin CAS.
No puede crear namespaces ni activar consumidores parados por esta vía.

Se mantienen las comprobaciones de activación, RBAC, admisión y disponibilidad
del aplicador normal. Si fallan después de entrar en el tramo de efectos, sus
protecciones de emergencia pueden parar consumidores; esa es una excepción de
seguridad explícita, no un cambio de datos autorizado. No levantar esa protección
para forzar la vía corta. El Lease coordina operadores cooperativos, no impide
cambios de administradores ajenos al procedimiento durante la operación.

## Aceptación y reversión

Tras el cambio Hubs, reiniciar Reticulum con la MISMA imagen y configuración por
el procedimiento existente para renovar su HTML cacheado. Este reinicio es el
único efecto adicional normal previsto; no cambia esquema, datos o credenciales.
Ejecutar `deployment/verify-live-reactivation.sh` y abrir navegador interno frío:
APP/AFRAME/escena, ropa/manos, sentarse/levantarse/repetir y observador remoto.
Registrar lo que realmente se ha visto. No cerrar por tests locales solamente.

Si la aceptación falla, regenerar el manifiesto con el digest previo y usar la
MISMA vía restringida, intercambiando FROM y TO. Reiniciar Reticulum de nuevo y
repetir la verificación viva. No usar `rollout undo`, parches manuales o restaurar
la DB para deshacer un simple cambio visual. Si hay deriva, recuperación activa
o fallo del comando, parar y comunicar el error: no convertir el rollback en una
reaplicación completa sin el análisis/checkpoint correspondiente.

No hay promesa de tiempo fijo: instalar dependencias o construir una imagen
puede tardar. La mejora verificable es que esta entrega no depende de ejecutar
otra vez recuperación, H5 o respaldos completos no afectados.
