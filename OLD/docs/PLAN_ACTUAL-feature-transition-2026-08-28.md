# PLAN ACTUAL — transición limpia a la siguiente feature

> **ARCHIVADO EL 28 DE AGOSTO DE 2026.** La transición terminó cuando el
> propietario eligió Sitting v2 y se abrieron las ramas locales exactas. Este
> documento conserva F0-F4 y sus evidencias, pero ya no dirige trabajo. La
> única cola ejecutable está en `../../PLAN_ACTUAL.md`.

Version: **v1 — EJECUTABLE HASTA ELEGIR UNA FEATURE**
Ultima revision: **28 de agosto de 2026 (Europe/Madrid)**
Autoridad: **este fichero es la única cola ejecutable**. El plan cerrado de H5
se conserva completo en
`OLD/docs/PLAN_ACTUAL-h5-cerrado-2026-08-28.md`. El historial de sesión no
decide el orden de trabajo.

## Resultado buscado

Salir de recovery de forma definitiva y abrir una sola feature de producto en
un entorno Git limpio, privado y reproducible, sin arrastrar ramas antiguas ni
mezclar feature, actualización upstream, modernización de infraestructura o
limpieza histórica.

Este plan termina cuando exista:

1. un worktree limpio para features, basado en el corte local aceptado;
2. documentación de estado coherente con el Git actual y el runtime aceptado;
3. una única feature elegida por el propietario;
4. un plan v2 específico para esa feature, con alcance y aceptación
   observables.

No implementa todo el backlog y no convierte la transición en otro proyecto
indefinido.

## Estado confirmado

- H5 está cerrado. La hibernación y recuperación productivas, DB, medios,
  navegador, audio, bots históricos, integración y CI final están aceptados.
- El hardening operativo posterior está cerrado localmente en
  `codex/hibernation-ops-hardening`; su corte de transición `407353d` está
  limpio y contiene cinco commits sobre `origin/main`. No se ha publicado y no
  bloquea features.
- El checkout `/Users/Shared/Gits/YenHubs` no se usa para trabajo nuevo: su
  rama `codex/recovery-closure` está 14 commits por delante y 63 por detrás de
  `origin/main`, con cambios versionados y material sin seguimiento que se
  preserva sin limpiar.
- El corte fuente integrado fija Hubs
  `ce8390a8905fa38fa0acdb10d5f94290981477ec` y Hubs Cloud
  `6d9ee9e998f636fcf61a4928cd2a275829768259`.
- Producción conserva parte del runtime histórico aceptado. Integración en Git
  no equivale a imagen construida, staging, despliegue ni aceptación live del
  runtime moderno.
- Tercera persona, Obsidian Aurora, landing, español, full-body/Mixamo, bots
  históricos con navmesh/chat, sitting básico, Admin, Spoke operativo e
  hibernación ya existen. No se reimplementan.

## Alcance y límites

Incluido en esta transición:

- crear un worktree local limpio y una rama para la feature elegida;
- verificar los dos gitlinks y ramas de los submódulos antes de editar;
- corregir solo bloques de estado obsoletos que puedan provocar trabajo
  repetido;
- elegir una feature y sustituir este plan por su plan específico.

Fuera de alcance hasta una autorización o plan posterior:

- borrar, limpiar, fusionar o reutilizar los worktrees históricos;
- publicar commits, abrir PR, ejecutar GitHub Actions o hacer deploy;
- tocar DigitalOcean, producción, DNS, credenciales, datos o costes;
- ejecutar otro restore, checkpoint o `verify-project.sh --full`;
- modernizar Spoke, certificar capacidad, actualizar upstream o implementar
  varias features a la vez.

Git puede permanecer completamente local y privado durante diseño,
implementación y pruebas locales. Publicar en un repositorio privado solo será
necesario si más adelante se autoriza CI, construcción de imágenes o rollout.

## Candidatas de producto

### 1. Sitting autoritativo v2 — recomendada

El código cliente/servidor está integrado, pero faltan staging, carrera real de
dos navegadores y aceptación live. Cierra la brecha concreta de doble ocupación
de una silla y reutiliza trabajo ya hecho en vez de crear otra arquitectura.

### 2. Carga neutral de avatares GLB — alternativa rápida y visible

El flujo privado existe en fuente. Falta aceptar el nombre neutral en live y
realizar un guardado real con un GLB reciente, idealmente un piloto local
MPFB/MakeHuman, comprobando preview, privacidad y persistencia.

### 3. Personalidad individual por bot — feature posterior

Hoy todos los bots de una sala comparten prompt. Personalidad, instrucciones o
memoria por bot requieren esquema persistido, Admin/UI, límites y aislamiento.
No se mezcla con la promoción del runtime durable.

### Backlog no ejecutable en este plan

- runtime durable de bots: promoción técnica separada antes de prometerlo como
  runtime público moderno;
- VR físico y mejoras opcionales de cámara como zoom/colisión;
- capacidad física: certificación antes de prometer cifras de concurrencia;
- Spoke legacy: modernización incremental de mantenimiento, no feature de
  cliente;
- proveedor de avatares embebido: bloqueado hasta decisión contractual,
  privacidad y coste.

## Plan de producción

### F0. Conservar el cierre anterior

- [x] Archivar completo el plan H5 anterior en
  `OLD/docs/PLAN_ACTUAL-h5-cerrado-2026-08-28.md`.
  - Estado: **DONE**.
  - Evidencia: el archivo histórico existe, se declara no ejecutable y está
    indexado en `OLD/README.md`.
- [x] Mantener H5 y el hardening local cerrados, sin repetir pruebas ni
  trasladarlos a la nueva cola.
  - Estado: **DONE**.

### F1. Preparar un workspace limpio y privado

- [x] Crear `/Users/Shared/Gits/YenHubs-features` como worktree nuevo desde el
  commit limpio que contiene este plan.
  - Estado: **DONE**.
  - Hecho cuando: `git status` está limpio y la rama no contiene ni absorbe el
    checkout histórico `codex/recovery-closure`.
  - Evidencia: rama local `codex/feature-transition` creada desde `407353d`;
    checkout limpio antes de iniciar F2.
- [x] Inicializar y verificar los gitlinks exactos Hubs `ce8390a` y Cloud
  `6d9ee9e`; antes de editar un submódulo, crear su propia rama
  `codex/<feature>` desde la base correcta.
  - Estado: **DONE**.
  - Hecho cuando: los dos objetos existen, coinciden con el root y ningún
    submódulo editable está en una rama equivocada.
  - Evidencia: ambos submódulos están inicializados, limpios y desacoplados en
    `ce8390a8905fa38fa0acdb10d5f94290981477ec` y
    `6d9ee9e998f636fcf61a4928cd2a275829768259`. No se editaron; su rama exacta
    se abrirá solo después de F3.
- [x] Inventariar los worktrees existentes solo por ruta, rama, limpieza y
  relación con `origin/main`.
  - Estado: **DONE**.
  - Hecho cuando: quedan clasificados como conservar, revisar después o base
    activa, sin borrar ni mover bytes.
  - Evidencia: `docs/worktree-inventory-2026-08-28.md`; no se limpió, movió ni
    eliminó ningún checkout histórico.

### F2. Reconciliar la documentación que puede causar loops

- [x] Actualizar únicamente los bloques de estado de
  `features/bots/README.md`, `docs/customization-inventory.md` y
  `docs/spoke-legacy-audit-2026-07.md` que aún presentan merges o gitlinks ya
  cerrados como pendientes.
  - Estado: **DONE**.
  - Hecho cuando: cada documento distingue `implementado`, `integrado`,
    `construido`, `live`, `aceptado` y `pendiente`, sin reescribir el historial.
  - Evidencia: los tres documentos fijan root `origin/main=4811101`, Hubs
    `ce8390a` y Cloud `6d9ee9e`; eliminan como pendientes los merges/gitlinks
    cerrados y mantienen el runtime durable fuera de la aceptación live.
- [x] Comprobar que los documentos activos remiten únicamente a este plan y
  que `OLD/` sigue siendo evidencia opcional, nunca una cola.
  - Estado: **DONE**.
  - Verificación: enlaces dirigidos, búsqueda de referencias ejecutables
    obsoletas y `git diff --check`; no requiere suites de producto.
  - Evidencia: `docs/completion-plan-2026-07-18.md` ya remite a
    `../PLAN_ACTUAL.md`; el antiguo plan H5 se declara histórico y no hay otra
    autoridad ejecutable. `git diff --check` pasa.

### F3. Elegir una única feature

- [ ] El propietario elige **Sitting v2** o **GLB neutral** como primera
  feature. Sitting v2 es la recomendación técnica; GLB neutral es la
  alternativa visible más pequeña.
  - Estado: **WAITING — decisión de producto**.
  - La espera no bloquea F1 ni F2.
- [ ] Tras la elección, crear la rama exacta y reemplazar este plan por v2 con
  un único resultado, requisitos, no objetivos, pruebas y aceptación.
  - Estado: **WAITING** de la elección.
  - Hecho cuando: ninguna otra candidata aparece como trabajo ejecutable.

### F4. Delimitar la frontera de release de la feature elegida

- [ ] Comparar el source exacto con el runtime aceptado antes de decidir qué
  imágenes necesita la feature; no usar documentos históricos como estado
  live.
  - Estado: **WAITING** de F3.
- [ ] Separar cualquier promoción del runtime moderno de la implementación de
  producto. Si la feature necesita backend moderno, su rollout compatible se
  prueba primero en staging y no se combina con upstream, Spoke o capacidad.
  - Estado: **WAITING** de F3.
- [ ] Definir rollback y aceptación real antes del primer efecto externo.
  - Estado: **WAITING** de F3.
  - Nota: este plan no autoriza build, staging, producción ni coste.

## Estado de trabajo

- Completado: F0 archivo H5, F1 workspace limpio y F2 reconciliación
  documental.
- Activo: ninguno; no queda trabajo independiente que no anticipe la elección.
- Waiting: F3 decisión del propietario entre Sitting v2 y GLB neutral.
- Bloqueos técnicos: ninguno.
- Reanudación: elegir una de las dos opciones; entonces se abre su rama exacta
  y este plan se sustituye por v2.
- Efectos externos realizados: ninguno.

## Reglas anti-loop

1. Una feature por rama y por plan. No se mezcla con recovery, upstream,
   capacidad, Spoke o modernización general.
2. Un estado documental no prueba runtime. Fuente, build, staging, live y
   aceptación se registran por separado.
3. No se repite un PASS si no cambian sus inputs ni su oráculo.
4. Pruebas focales durante implementación; un solo `--full` para el candidato
   final cuando realmente corresponda.
5. El checkout histórico se preserva y no se limpia para “poner orden”. El
   trabajo nuevo nace limpio en otro worktree.
6. Un fallo se corrige por su causa exacta y repite solo el verificador más
   cercano. Dos fallos equivalentes sin evidencia nueva producen STOP y
   replanteamiento.
7. Publicar, construir imágenes, desplegar, gastar o mutar datos exige una
   frontera y autorización posteriores; no se infiere de este plan.
8. El plan de transición termina al abrir el plan v2 de una feature. No absorbe
   el backlog restante.

## Artefactos clave

- Plan H5 archivado:
  `OLD/docs/PLAN_ACTUAL-h5-cerrado-2026-08-28.md`.
- Estado humano: `docs/estado-sencillo.md`.
- Historial: `docs/session-changelog.md`.
- Inventario de worktrees: `docs/worktree-inventory-2026-08-28.md`.
- Flujo Git/submódulos: `docs/development-workflow.md`.
- Sitting: `features/sitting/README.md`, `IMPLEMENTATION.md`, `TESTING.md`.
- Avatares: `features/avaturn/README.md`,
  `docs/avatar-provider-evaluation-2026-07.md`.
- Bots: `features/bots/README.md`.
- Operación y rollout: `deployment/README.md`.

## Punto de menor confianza

La prioridad comercial entre Sitting v2 y GLB neutral no puede demostrarse con
tests. Elegir mal no pierde código, pero puede dedicar la siguiente fase a una
mejora menos valiosa para el primer cliente. La comprobación más barata es una
decisión explícita del propietario después de ver este plan. Hasta entonces F1
y F2 son seguras y útiles para cualquiera de las dos opciones.
