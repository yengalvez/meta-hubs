# Productor de procedencia del runtime · 01/10/2026

Registro local, subordinado al [plan activo](/Users/Shared/Gits/YenHubs/PLAN/Plan_activo.md)
y al [contrato completo](/Users/Shared/Gits/YenHubs/DOC/fiabilidad-operativa-yenhubs-2026-10-01.md).
No es aceptación de imágenes, copias, staging ni cierre del Goal.

## Carencia reproducida

Al preparar los tres ciclos completos se comprobó que el consumidor
`deployment/verify-runtime-image-build-provenance.mjs` exige
`yengalvez/hubs-cloud/.github/workflows/runtime-images-build-push.yml`, pero
ese productor no existía en W ni en `master` remoto (API de contents:404).
El repositorio remoto está público, id1153407749 y default `master`.
`bot-images-build-push.yml` construye solo parent/runner; el workflow custom
no produce el conjunto coordinado atestado. No se reutilizan como si fueran
el productor exigido ni se modifica el consumidor para admitirlos.

La prueba nueva de existencia produjo exit1 y una aserción precisa:
`the required coordinated producer is missing` (chunk0ecfd2). Esto no explica
retroactivamente los fallos de streams multimedia ni acredita un build.

## Delta acotado

- Un workflow manual, un único job hospedado Ubuntu24.04, solo repositorio/id
  exactos y `master`; no dispatch automático, matriz independiente o cancelación
  de otro run. Mantiene las cuatro Actions de build/login existentes por SHA.
- Reticulum, parent y ghost runner desde el mismo checkout limpio, tres
  Dockerfiles reales y plataforma explícita `linux/amd64`. Tags ligados al
  SHA/run/attempt; tres digests de salidas del build, sin inputs de imagen/SHA.
- Helper de metadatos públicos: enlaza Git HEAD real, repository/ref/event,
  workflow ref/SHA, runner hospedado y run/attempt; rechaza falta de digest,
  formatos ajenos, checkout sucio y argumentos alternativos. Solo emite JSON
  canónico cerrado o un error genérico sin JSON parcial ni entorno.
- Cuatro llamadas a la Action oficial `actions/attest`, por SHA fijo: recibo
  y tres sujetos OCI separados. No se suministra un predicate fabricado.
  `create-storage-record:false` evita el registro adicional de almacenamiento;
  los OCI bundles se publican en GHCR. Fuente: [Action oficial](https://github.com/actions/attest/tree/1e69f48acb82d1966a394da916b4c1698aa569d6).
- Un paquete después de todos los pasos exitosos: `receipt.json`,
  `receipt.bundle.json`, `reticulum.bundle.json`,
  `bot-orchestrator.bundle.json`, `bot-runner.bundle.json`. Nombre con run/attempt,
  retención7 días, overwrite apagado, sin glob ni archivos ocultos/credenciales.
  No renombrar el recibo después de firmarlo: el consumidor enlaza su basename.

Las Actions nuevas se comprobaron en sus refs oficiales y fuentes exactas:
`actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6` (v4) y
`actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (v7).
El código sigue usando la firma OIDC de GitHub y el verificador existente;
no tiene claves nuevas, bypasses, cambios de generador o de producción.

## Pruebas y registro ordinario

83592 TERMINAL exit0: siete pruebas NUEVAS,1.409s en total. Cuatro de Cloud
comprueban receipt exacto,13 cortes de autoridad/checkout,15 cortes de digest
y CLI real en Git sintético propio: HEAD/control válidos, SHA distinta,
digest ausente, argumento ajeno y checkout sucio rechazan sin JSON parcial.
Tres de root comprueban existencia, YAML real/cableado de las Actions y
compatibilidad del JSON emitido con el inspector actual.

Los cuatro bundles de esa última prueba son explícitamente JSON de fixture
sin firma. El inspector solo comprueba formato/identidad de archivos; no se
invoca `gh attestation verify` ni se presenta esto como prueba criptográfica.
Hace falta una ejecución oficial exitosa y sus cinco artefactos verdaderos.

La revisión primaria separada comprobó permisos mínimos, source antes de
credenciales, publicación solo tras cuatro attestations exitosas, sujetos
por digest/run/attempt y limpieza del checkout. No es revisión independiente:
la ruta/modelo principal para delegar no estaba verificada.
Detectó además una dependencia fuera del cierre de recibos. Se añadieron
solo los tres archivos del productor a inputs security/recovery/h5; el resto
de superficies no se amplía. c62530 exit0,1/1 NUEVA guarda comprueba ese cierre,
exclusión de Dialog y registro local/CI. No se repitieron las siete válidas.

Cloud security CI ejecuta las cuatro unidades; `scripts/test-aud065.sh`
registra las ocho comprobaciones para el gate local/CI normal del proyecto.
YAML2.9.0 cacheado de F se leyó sin modificarlo ni instalar dependencias.
Scratch0700 `/private/tmp/ynbuild-producer-zhJs8C`; logs0600 `red.log`,
`canary.log`, `closure.log`. Entorno limpio y sandbox con toda red denegada
para tests; solo el Git sintético propio fue creado y retirado.

Gates cortos afectados chunkcfd44b exit0: sintaxis de los tres archivos Node,
Actionlint con ShellCheck de los dos workflows Cloud afectados, ShellCheck de
los dos scripts root cambiados y diff de root/Cloud. Log0600 `gates.log`.
91488 TERMINAL exit0: Gitleaks del árbol entregable root y Cloud por el helper
del proyecto, con la política Cloud existente,0 leaks; log0600 `secret-gates.log`.
Sin scanner Hubs ni otras suites repetidas. Package/lock de YAML idénticos a F
cacheado comprobados; scratch y los cinco logs son owner-only0700/0600.
Los commits se guardan primero en Cloud y luego se fija su gitlink en root;
los SHA exactos y el estado actual se registran en el plan canónico, sin que
un documento se atribuya el hash del commit que todavía está creando.

## Límites y siguiente paso

No push, dispatch, imagen descargada/construida, VM iniciada, Kubernetes
instalado ni cambio productivo en este bloque. El código sigue en ramas
candidatas. El verificador real conserva su requisito de root limpio
`main=origin/main` con Cloud integrado; no se le proporciona un override
del SHA para acreditar el candidato.

Quedan congelación/full exacto e integración antes del run oficial, verificación
criptográfica real y disponibilidad/arquitectura de todo el conjunto de imágenes,
receta de tres ciclos representativos y su ejecución, perfiles/STOP/UI completos,
tiempos integrales y aceptación real acotada. El checkpoint de preparar K3s en
la VM x86 existente sigue sin respuesta y no se infiere aprobación. Las
antiguas imágenes PAUSE del harness no cuentan como el producto desplegado.
El Goal completo permanece ACTIVE; no se abre ni reactiva otro monitor.
