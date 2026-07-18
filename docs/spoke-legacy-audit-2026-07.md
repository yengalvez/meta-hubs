# Auditoría de Spoke legacy — julio de 2026

## Resumen ejecutivo

Spoke sigue siendo operativo, pero conserva una pila de construcción legacy y
debe modernizarse como una línea de trabajo independiente. El objetivo inmediato
no es una actualización masiva: es recuperar un gate de pruebas fiable, reducir
riesgos en incrementos pequeños y preservar sin regresiones los contratos de
autoría y publicación que usa YenHubs.

A fecha de esta auditoría:

- producción continúa usando la imagen de Spoke fijada por digest que figura en
  el handoff (`sha256:f5120264938e189e702f835182ed4a28a5ce20b140d7262bc2a3074e6d0b6657`);
- el cambio original `0edd75b` (`Fix Spoke unit test discovery`) se integró como
  commit terminal `b7b752f` de `codex/bot-safety-final`; el puntero candidato
  raíz ya fija ese commit y ambas ramas estan publicadas, pero todavia no
  pertenecen a las ramas base ni estan desplegadas;
- Hubs Cloud PR `#1` esta `CLEAN` y verde contra `development`; despues de su
  merge queda el paso separado `development -> master`;
- el cambio modifica una sola línea de `package.json`: entrega el glob entre
  comillas a AVA para que AVA, y no el shell local, descubra la suite;
- con Node `16.13.2` y Yarn `1.22.22`, el comando corregido ejecutó localmente
  las 68 pruebas unitarias y terminó con 68/68 correctas;
- el snapshot Trivy local del 16 de julio informa 42 hallazgos en
  `services/spoke/yarn.lock`: 3 critical, 21 high, 17 medium y 1 low. Es un
  inventario del lockfile, no una demostración de que los 42 sean explotables
  en la imagen runtime.

Por tanto, Spoke está **operativo en producción**, mientras que la corrección
del gate esta publicada y validada como **candidata**, pero no fusionada ni
desplegada. Cualquier modernización descrita aquí sigue siendo trabajo separado.

## Alcance y evidencia

La revisión cubrió, sin mutar producción:

- `hubs-cloud/community-edition/services/spoke/package.json` y `yarn.lock`;
- `hubs-cloud/community-edition/services/spoke/Dockerfile`;
- el cambio original `0edd75b` y su commit integrado `b7b752f`;
- `output/project-audit-20260716-175953/security/hubs-cloud-trivy.json`;
- `output/project-audit-20260716-175953/spoke-wrapper-repro.log`, usado solo
  para demostrar el falso verde anterior de `1 test passed`;
- reproducción de esta sesión sobre `0edd75b` con Node `16.13.2`, Yarn
  `1.22.22` y `yarn unit-tests`: `68 tests passed` en 6,09 s;
- repeticion sobre `b7b752f` dentro del gate raiz completo y del job Spoke del
  PR Cloud `#1`, con lint, 68/68 y build verdes;
- la documentación de despliegue, handoff y auditoría vigente.

La reproducción 68/68 ya cuenta con evidencia local integrada y CI durable. No
sustituye el merge en `development`, el paso posterior `development -> master`,
una imagen candidata ni la aceptacion funcional de Spoke en staging.

No se ejecutó una actualización de dependencias, construcción de imagen,
rollout ni operación de escritura sobre un proyecto Spoke real.

## Baseline de compatibilidad

El baseline reproducible aprobado para el código actual es:

| Superficie | Baseline observado |
| --- | --- |
| Runtime de build | Node `16.13.2` |
| Gestor de paquetes | Yarn Classic `1.22.22` |
| Aplicación | Spoke `0.8.6`, React 16, Webpack 4 |
| Pruebas | AVA 3.10.1 con `esm` y Babel |
| Imagen final | Nginx Alpine |

Aunque `package.json` declara `node >=10`, eso no constituye un baseline
validado. Los gates de este repositorio deben seguir usando Node `16.13.2` y
Yarn `1.22.22` hasta que una rama dedicada demuestre una migración posterior.
Node 16 y varias piezas de la toolchain ya son legacy; cambiar Node, Webpack,
Babel, React y las dependencias de escena a la vez eliminaría la capacidad de
atribuir una regresión a un cambio concreto.

## Hallazgos

### SPK-001 — El gate unitario de la rama base solo descubre una prueba

`hubs-cloud/master` conserva este script:

```json
"unit-tests": "ava ./test/unit/**/*.test.js"
```

El shell expande el patrón de forma dependiente del entorno antes de que AVA lo
procese. La evidencia del gate anterior muestra `1 test passed`, aunque existen
muchos más tests bajo `test/unit`.

El cambio original `0edd75b`, integrado como `b7b752f`, lo cambia a:

```json
"unit-tests": "ava \"./test/unit/**/*.test.js\""
```

La ejecución directa con el patrón citado descubrió y pasó 68/68 pruebas. El
cambio es mínimo y no modifica el bundle ni el comportamiento runtime. Debe
integrarse primero, por sí solo, para que los trabajos posteriores no partan de
un falso verde.

### SPK-002 — Deuda de dependencias confirmada por el snapshot

El reporte Trivy local atribuye al `yarn.lock` de Spoke:

| Severidad | Hallazgos |
| --- | ---: |
| Critical | 3 |
| High | 21 |
| Medium | 17 |
| Low | 1 |
| **Total** | **42** |

Los critical del snapshot señalan `@babel/traverse` 7.5.5, `form-data` 2.5.1 y
`fsevents` 1.2.9. Antes de cambiar versiones hay que clasificar cada ruta como
runtime, build, desarrollo u opcional, comprobar si llega al artefacto final y
validar la versión de corrección compatible. En particular, contar un hallazgo
de un lockfile no equivale automáticamente a exposición remota del Nginx que
sirve los assets compilados.

La deuda es real y no debe silenciarse con `npm audit fix --force`, resoluciones
globales ni una regeneración indiscriminada del lockfile.

### SPK-003 — La cadena de imagen usa bases no fijadas por digest

El Dockerfile usa `node:16.13`, `alpine/openssl` y `nginx:alpine`. Aunque la
imagen desplegada por YenHubs queda fijada por digest, las bases del build son
tags mutables y una reconstrucción futura puede producir bytes distintos sin
un cambio en el repositorio.

La primera corrección de esta superficie debe fijar los tres `FROM` por digest
manteniendo las mismas familias y demostrar un build reproducible. No debe
mezclarse con el salto de Node, Nginx o Alpine.

### SPK-004 — El contenedor final no declara usuario no privilegiado

La etapa final hereda el usuario predeterminado de `nginx:alpine`; el Dockerfile
no contiene `USER`. Pasar a un UID/GID numérico no root requiere preparar los
permisos de `/www`, `/ssl`, la configuración de Nginx, el script de entrada y el
puerto de escucha. No es seguro añadir solo `USER` sin probar todo ese contrato.

La migración debe tener una rama y un rollout aislados, con `runAsNonRoot`,
`allowPrivilegeEscalation: false`, capabilities vacías y seccomp verificados en
el artefacto y en un pod aislado antes de tocar producción.

### SPK-005 — El Dockerfile no aporta un healthcheck de imagen

No existe una instrucción `HEALTHCHECK` en el Dockerfile final. Nginx sí define
un endpoint HTTPS `/healthz`, pero el generador solo crea una liveness probe y
configura su `httpGet.path` como `https://localhost/healthz` aunque el campo debe
contener la ruta `/healthz` (el esquema ya está separado como `HTTPS`). No hay
startup ni readiness probe de Spoke.

La corrección debe hacerse en una rama de runtime separada: usar el endpoint
existente con path/scheme válidos, añadir startup/readiness/liveness con
umbrales probados y hacer que el verificador rechace cualquier regresión. No se
debe editar el manifiesto generado a mano ni mezclar este cambio con la
modernización de Node/dependencias.

### SPK-006 — Otros riesgos de suministro y mantenimiento

- La etapa de certificados genera una clave TLS autofirmada de larga duración
  durante el build y la copia a la imagen final. Hay que documentar primero su
  uso interno antes de sustituirla o retirarla.
- El stack mezcla paquetes antiguos y dependencias obtenidas desde commits de
  Git. Sus referencias y checksums deben permanecer deterministas.
- La suite legacy produce mensajes de APIs de navegador y carga de assets aun
  cuando termina verde. Los gates deben basarse en el código de salida y, en
  paralelo, reducir el ruido para que un fallo real no quede oculto.
- Una modernización de Node puede afectar Webpack, loaders, Puppeteer, AVA,
  `esm`, Babel, Three.js/Recast y la serialización de escenas. Esas superficies
  no deben actualizarse en bloque.

## Contratos que hay que preservar

El fixture de aceptación no se infiere por nombre: el inventario vivo conocido
que debe compararse antes y después es el proyecto `qa3U3Ke`, escena publicada
`f6VKtim`, propietario operativo `info@virtualmente.com`, un `Floor Plan` con
`nav-mesh`, ocho waypoints `spawbot-*` y dos waypoints de asiento. Los dos
asientos deben conservar `Disable motion`, `Can be occupied`, `Clickable` e
identidad de red estable. Una prueba mutable usa primero un duplicado no
referenciado; estos identificadores sirven como contrato de comparación, no
como autorización para modificar producción.

Todo cambio en Spoke debe mantener, como mínimo:

1. Apertura y guardado del proyecto editable actual sin pérdida de entidades ni
   referencias de assets.
2. Publicación normal a través de las APIs de Spoke/Reticulum, incluido el retry
   autenticado del POST final y la cancelación de uploads.
3. Componente `Floor Plan` y generación de un `nav-mesh` válido en el GLB
   publicado.
4. Nombres y posiciones de los puntos `spawbot-*`, junto con los flags y la
   identidad estable de los waypoints.
5. Waypoints de asiento con `Disable motion`, `Can be occupied` y `Clickable`
   cuando corresponda.
6. SID de la escena y contratos de sustitución/reconciliación de media cuando la
   prueba pretende actualizar una escena existente.
7. Carga correcta de la escena en Hubs, navegación de bots sobre navmesh y
   sitting en clientes desktop y móvil.

Las pruebas de publicación o borrado deben realizarse primero sobre un duplicado
sin referencias de salas. Un proyecto o escena de producción no es un fixture.

## Plan incremental recomendado

### Fase 0 — Recuperar el gate real

1. `Completado en candidato`: integrar el cambio como `b7b752f` sin mezclar una
   modernizacion de dependencias.
2. `Completado en candidato y CI`: ejecutar lint, 68 pruebas unitarias y build
   con Node `16.13.2`/Yarn `1.22.22`.
3. `Pendiente`: fusionar Cloud `#1` en `development`, abrir y fusionar
   `development -> master` y solo despues integrar definitivamente el puntero
   del repositorio raiz.

Este cambio no necesita una imagen nueva por sí mismo: no altera el bundle. Si
se decide construirla, sigue aplicando el workflow estándar y todos los gates.

### Fase 1 — Hacer reproducible el artefacto actual

En una rama separada, fijar por digest las tres imágenes base y generar SBOM y
Trivy tanto del árbol como de la imagen final. Mantener Node 16.13.2, Yarn 1 y el
lockfile funcional para aislar el efecto.

### Fase 2 — Endurecer el runtime Nginx

En otra rama, introducir usuario numérico no root y probes compatibles con el
generador. Validar permisos, puerto, TLS interno, assets y página `/spoke` en un
contenedor y pod aislados. No combinar esta fase con upgrades de JavaScript.

### Fase 3 — Resolver advisories por superficie

Orden sugerido:

1. confirmar el grafo y alcance de los 3 critical;
2. corregir una dependencia o familia estrechamente acoplada por rama;
3. regenerar solo las entradas necesarias del lockfile;
4. volver a ejecutar 68 pruebas, lint, build, SBOM y Trivy;
5. conservar un informe de diferencias de bundles y escenas.

El objetivo es reducir el conteo con evidencia, no obtener un número cero a
costa de romper compatibilidad.

### Fase 4 — Migrar la toolchain

Solo tras estabilizar las fases anteriores, ensayar saltos de Node y toolchain
en incrementos compatibles. Cada salto debe declarar qué versión de Node,
Webpack/Babel/AVA y qué contratos de escena cambia. React/Three.js/Recast y la
serialización/publicación merecen ramas propias si requieren cambios de código.

## Gates de aceptación

### Antes de construir

- diff limitado a una sola fase y sin secretos;
- `yarn lint` con Node `16.13.2` y Yarn `1.22.22` mientras ese sea el baseline;
- `yarn unit-tests`: exactamente 68 pruebas descubiertas y cero fallos;
- `yarn build` correcto;
- `./scripts/verify-project.sh` y `./scripts/verify-project.sh --full` desde la
  raíz;
- Gitleaks, Actionlint, ShellCheck, SBOM y Trivy revisados, sin ocultar nuevos
  hallazgos.

### Imagen y pre-rollout

- construcción exclusivamente mediante el workflow aprobado de GitHub Actions;
- imagen de candidato y bases identificadas por digest;
- smoke HTTP de `/spoke` y comprobación de assets críticos;
- si cambia el runtime: UID/GID, capabilities, seccomp y probes verificados en
  un pod aislado;
- checkpoint completo de PostgreSQL y `ret-pvc` antes de cualquier mutación de
  producción;
- `npm run gen-hcce`, `kubectl diff` y revisión de que el manifiesto cambia solo
  la superficie prevista.

No se permite sustituir este flujo por hotpatches, `kubectl set image`,
`kubectl cp`, builds dentro del clúster ni edición manual de `hcce.yaml`.

### Aceptación funcional

1. Carga fría de Spoke y autenticación real sin errores ni warnings.
2. Apertura, guardado y relectura de un duplicado seguro del proyecto.
3. Publicación del duplicado, validando GLB, assets, Floor Plan, navmesh y todos
   los waypoints esperados.
4. Carga fría desktop y móvil de una sala que use la escena candidata.
5. Revalidación de navegación de bots y sitting cuando el cambio pueda afectar
   Three.js, Recast, exportación o waypoints.
6. `./deployment/verify-live-reactivation.sh` con cero fallos y cero warnings.
7. Todos los Deployments Ready, sin reinicios anómalos y `kubectl diff` vacío.

## Rollback

Antes del rollout se debe conservar el digest live anterior y el checkpoint
completo. Ante un fallo:

1. detener la aceptación y no continuar con otras modernizaciones;
2. restaurar el digest anterior en los valores rastreados/permitidos;
3. regenerar `hcce.yaml`, revisar `kubectl diff` y aplicar el manifiesto por el
   procedimiento estándar;
4. repetir la carga fría y el verificador live;
5. restaurar DB y storage juntos solo si la prueba mutó datos y la validación
   demuestra que el rollback de imagen no basta.

El rollback no debe reescribir historia publicada ni introducir parches manuales
en el clúster. Cada fase queda aceptada únicamente cuando su commit está en la
rama base del subrepositorio, el repositorio raíz fija ese commit y la evidencia
de build/rollout/aceptación está documentada.
