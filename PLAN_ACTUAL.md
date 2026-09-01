# PLAN ACTUAL — Aceptación de avatares GLB privados

Versión: **GLB v1 — publicación y rollout autorizados; aceptación persistente pendiente**
Última revisión: **1 de septiembre de 2026 (Europe/Madrid)**
Autoridad: **este fichero es la única cola ejecutable**.
El plan completo de Sitting v2 está cerrado y archivado en
`OLD/docs/PLAN_ACTUAL-sitting-v2-completed-2026-08-30.md`.

## Resultado y límite

Demostrar que un cliente puede cargar un avatar GLB compatible, verlo y usarlo
correctamente, guardado en su cuenta **sin publicarlo en el catálogo**.
Se acepta la función existente; solo se implementará una corrección si aparece
un fallo reproducible. No se construye un editor ni una integración de proveedor.

**Privado significa no listado**, no cifrado ni inaccesible mediante su URL:
otras personas en la sala necesitan poder representar el avatar.
La cuenta B no debe recibirlo en Mis avatares ni poder modificar el de A.
Los contratos primarios son `features/avaturn/README.md` y
`features/rpm-avatars/README.md`.

H5 y Sitting v2 permanecen terminados. No se repiten restore, `--full`,
staging, E2E de exclusión de sillas ni rollout por abrir este plan.
Bots, proveedores externos, upgrades upstream y limpieza DNS son trabajos
separados. El propietario autorizó el 1 de septiembre publicar e integrar el
candidato de código actual y desplegarlo sobre la instancia productiva existente
de `meta-hubs.org`, con checkpoint conjunto DB + medios previo y verificación
fría posterior. No autoriza recursos nuevos, cambios de topología o coste,
publicar/subir las muestras Avaturn/Mixamo ni escrituras de aceptación con dos
cuentas.

## Fuente y evidencia que se conservan

- Workspace: `/Users/Shared/Gits/YenHubs-features`.
- Rama local: `codex/private-glb-acceptance`, desde `origin/main`
  `34faabccb328df1faad75590401d7dfbb859311b` (cierre Sitting, PR #21).
- Gitlinks del candidato de cierre: Hubs
  `668413a209fc0b7725c254047e104d5545d833c1`; Cloud
  `43210079d3ddcd8ec7a5d9588cf3546a8efce9b0`. Hubs ya está integrado en la
  raíz; el puntero Cloud corresponde al hardening causal posterior al rollout
  y se integra en el cierre documental.
- La preparación está guardada en el commit raíz local `e454251`. El candidato
  posterior de selección se publicó como Hubs PR #7 y está integrado en
  `master=668413a209fc0b7725c254047e104d5545d833c1` (candidata original
  `e83adaf38715f837a30d390273f488ffc2bcf42b`): selector y preview, una
  utilidad de encuadre y dos focales. El gitlink raíz quedó integrado mediante
  la PR #22 en `main=4f3d91a176e8b0b7514bfe018328dcefacf6282e`. La imagen nueva
  ya fue construida, desplegada y verificada; la PR raíz #24 integró el cierre
  y ambos gitlinks en `main=7fcda31b0d4e2fe89c462c5e07ab9471d3b0cbcf`.
- El build Hubs [33245207737](https://github.com/yengalvez/hubs/actions/runs/33245207737)
  pasó sobre `b2697e7e6f571d195346cc156f0f1631eedc841a`.
  Al abrir G0, editor, selector, ayuda, validadores y español coincidían con ese
  corte. La interfaz neutral ya estaba incluida en la imagen publicada;
  la nueva corrección local del editor del 31 de agosto todavía no.
- El rollout aceptado de Sitting fijó Hubs
  `sha256:e8f9423ace1bf4108ae5a7ce59c1b45cf0b44b74ea944fdb82fee47e4d7be5b0`
  y Reticulum
  `sha256:256c292d0d5a69e021322bdbd11b3f318f2d44bee580433252e0b04ade1d5e18`.
  Su evidencia está en `docs/session-changelog.md`, bloque del 30 de agosto.
  No es una recaptura de Kubernetes ni una aceptación de subidas GLB.
- El navegador interno cargó en frío el vestíbulo de
  `https://meta-hubs.org/VJopCY3/inicio` en escritorio y 390×844 con el bundle
  nuevo `hub-5733d7ae4df22f27da2e.js`, WebGL, cero errores y sin overflow. El
  único warning es `background`, heredado y ya clasificado. El modo Mirar
  confirmó el vestíbulo privado, pero no se pulsó Entrar, no se abrió el
  selector y no se subió/guardó nada: persistencia y dos cuentas siguen pendientes.
- La fuente fuerza `allow_promotion=false` y `allow_remixing=false`.
  Reticulum comprueba propiedad, credenciales de ficheros y tamaños;
  eso no demuestra por sí solo validación completa del rig en servidor.
- Hay 2 casos unitarios de textos neutrales y 3 de skeleton sintético.
  No equivalen a abrir GLB reales ni a guardar con dos cuentas.
  No se han repetido esas pruebas sobre código inalterado.
- La focal nueva `hubs/test/unit/react-components/avatar-editor-selection.test.js`
  reproduce 3 fallos sobre la base: Guardar habilitado tras GLB corrupto/grande
  y procesamiento del anterior al enviar. Tras la corrección pasa **11/11**
  con el editor React montado y validadores reales; parser 3D, preview y
  transportes están aislados. No es aceptación visual ni guardado en servidor.
  ESLint de los dos archivos y diff-check pasan. La recomprobación independiente
  dirigida del hallazgo no encontró huecos materiales; no se reabrió la auditoría.
  Los avisos locales de Browserslist antiguo y `punycode` no son fallos de esta
  focal y no justifican actualizar dependencias dentro de este cambio.
- La candidata congelada `e83adaf38` pasó una sola vez la sección oficial
  `hubs`: lint, **119/119** unidades (incluidos 11 selector + 8 bounds/cámara),
  compilación Hubs y lint/compilación Admin. El recibo privado exacto quedó
  ligado al input `2e387a74d5deb3397073a748bffdd6d25ed430f4c3457b9656d835c4a8f09629`.
  No se repite esa sección sobre los mismos bytes.
- La PR Hubs #7 pasó sus dos controles `static-security` y el workflow completo
  `test-and-deploy-storybook`; se fusionó con `[skip ci]` en `668413a20`. No se
  abrió un run post-merge duplicado.
- La PR raíz #22 dejó verdes los gitlinks, Gitleaks de worktree/rango,
  Actionlint, ShellCheck y PostgreSQL 12.19/14.23. Su último subpaso intentó
  repetir la batería histórica de recovery sin cambios: se canceló
  deliberadamente tras 22 minutos para respetar este plan. La PR se fusionó
  por administración con `[skip ci]` en `4f3d91a17`; no se presenta ese job
  cancelado como verde ni como evidencia GLB.
- Por indicación del propietario, el agente obtuvo muestras públicas Avaturn
  y Mixamo Xbot: ambas cargan y se ven localmente, con sus hashes y límites de
  uso en [la evidencia de muestras](features/avaturn/sample-check-2026-08-31.md).
  No hace falta que el propietario busque archivos. No es aceptación del
  editor ni autorización de uso comercial; tampoco se han subido al servidor.
- El bloque autónomo posterior montó **AvatarEditor y AvatarPreview reales**
  localmente, con Three/WebGL, estilos, split GLB y PNG reales; aisló en memoria
  cuenta/upload y usó GLTFLoader directo en lugar del wrapper/proxy Hubs.
  Se reprodujo y corrigió el encuadre Xbot, incluyendo manos en formato vertical.
  Ambos positivos dan preview y miniatura de 720×1280. Los tres negativos
  deshabilitan Guardar y no aumentan los dos envíos simulados. Pasan 6 casos de
  bounds y 2 de cámara; no se repitió la focal 11/11, cuyos hashes se conservan.
  Esto no prueba la integración completa del loader, servidor, permisos o sala.

## Comprobaciones finitas de aceptación

Se reutiliza cada evidencia verde sobre los mismos bytes y condiciones. Una
corrección repite solo los casos que pueda invalidar.

1. **Dos positivos reales:** GLB 2.0 procedentes de dos pipelines distintos;
   entre ambos cubren upper-body compatible y full-body/Mixamo. Registrar
   procedencia/licencia, SHA-256, tamaño y rig. No cuentan mocks ni clips de
   animación sin avatar.
2. **Tres negativos:** corrupto, mayor de 64 MiB y sin skeleton compatible.
   Rechazo comprensible antes de guardar, sin crear avatar/listing.
   Probar los límites del servidor solo con focales locales, no mediante
   cargas maliciosas ni archivos gigantes en producción.
   Incluir localmente la transición **válido → rechazado**: Guardar bloqueado
   o archivo anterior conservado identificado inequívocamente; nunca guardar
   un archivo distinto del que la UI confirma. No basta empezar siempre vacío.
3. **Editor:** entrada neutral y ayuda visibles; preview y rig válidos antes
   de habilitar Guardar. La miniatura se genera durante el guardado y debe
   verse tras recargar. Repetir para cada positivo, sin aceptar preview vacío.
4. **Guardado de A:** reaparece tras recargar en Mis avatares y puede
   seleccionarse. Readback del avatar exacto: propietario correcto, ambos
   flags en false, cero `avatar_listing`, ausente de Featured/búsqueda pública.
5. **Cuenta B aislada:** no aparece en sus Mis avatares ni ofrece edición.
   El control API de modificación ajena se verifica con test local; no se
   intenta una escritura ajena en producción. Su visualización remota es
   esperada, no una filtración del listado.
6. **Uso real:** primera/tercera persona, idle/walk/run, sentarse/levantarse,
   manos, escala, orientación y contacto con suelo; B ve pose y movimientos
   coherentes. La pose se prueba con estos avatares, sin repetir la carrera
   de exclusión ya aceptada de Sitting v2.
7. **Carga fría y conservación:** escritorio y móvil con los nuevos avatares,
   sin errores ni warnings inesperados. Conservar los avatares preexistentes.
   No hay migración ni rollout para una aceptación sin cambios de código;
   si hay corrección, probar compatibilidad/rollback de datos localmente y
   preparar reversión del cliente, sin restaurar toda la DB como prueba.

## Cola ejecutable

### Bloque autónomo solicitado el 31 de agosto

Bloque local completado: previews/miniaturas reales, tres negativos y corrección
causal de cámara con sus focales. Se trabajó individualmente, sin supervisión
rutinaria, sin repetir bloques verdes y sin crear monitor. El Goal de este
bloque se cierra al entregar su evidencia; **no equivale al cierre de G2 ni de
la feature**. La publicación,
licencias para ese destino, cuentas y escrituras productivas conservan sus
puertas. Se avisa solo ante una decisión imprescindible, no entre pruebas.

### Bloque de publicación y rollout autorizado el 1 de septiembre

Congelar una sola candidata exacta, validarla proporcionalmente sin repetir
H5, Sitting ni `--full`, integrar primero Hubs y después el gitlink raíz,
construir la imagen Hubs por el workflow oficial y fijarla por digest. Antes de
aplicar, crear un checkpoint conjunto DB + `ret-pvc`; regenerar, revisar y
aplicar mediante el driver protegido, reiniciar Reticulum y ejecutar el
verificador live más una carga fría. Se conserva la imagen anterior como
rollback. Este bloque no completa G2 ni habilita la subida de muestras de
terceros.

### G0 — Cierre anterior y alcance

- [x] Confirmar main/gitlinks, rama limpia y cierre de H5/Sitting.
- [x] Guardar el plan Sitting exacto y registrar su sustitución en OLD.
- [x] Limitar GLB a aceptación existente y separar fuente de prueba live.
- [x] Revisión independiente única del plan: corregida la secuencia de
  miniatura y añadido el caso válido → rechazado. No hubo cambio de producto.
- [x] Validación documental: archivo Sitting byte-idéntico, diff-check,
  enlaces locales, Gitleaks de los siete documentos y Actionlint/ShellCheck
  de workflows raíz sin fallos; gitlinks inalterados. Sin suite de producto.

### G1 — Preparar archivos y una sesión acotada

- [x] Inventariar los dos ejemplos iniciales y los 42 GLB trackeados de Hubs y
  Cloud: ninguno reúne mesh con skin y los 12 huesos exigidos por el importador.
- [x] Focal local válido → rechazado: fallo reproducido y corregido. Se
  invalida el anterior antes de leer el nuevo, se descartan validaciones
  tardías y se impide cambiar de archivo durante el envío. **11/11** cubre
  corrupción, tamaño, submit directo, espera, carreras, cancelar, reintentar,
  rig incompatible, alias privado histórico y bloqueo durante upload.
- [x] Obtener por encargo del propietario dos muestras públicas reales de
  Avaturn y Mixamo; registrar fuentes, tamaños, hashes y condiciones de uso.
  Se conservan fuera de Git y solo para evaluación local, no para redistribución.
- [x] Cargar los dos archivos con el loader y validadores actuales en navegador
  interno: 52/67 huesos, upper-body requerido y full-body válidos, modelos
  visibles y sin errores de consola. Ambos son full-body; no se declara
  aceptado por separado un archivo solo upper-body ni el flujo persistente.
- [x] Probar el preview real del editor: Xbot reproducía el encuadre incorrecto.
  Corregidos bounds con skin/morphs y cámara según ancho/alto; los dos modelos
  y sus PNG se ven completos. Seis casos geométricos y dos de cámara pasan.
- [x] Tres negativos en el editor local: corrupto, 64 MiB + 1 byte y GLB
  serializado sin skin. Mensaje correcto, Guardar bloqueado y cero nuevos envíos.
  Los criterios 1–3 tienen evidencia local con las limitaciones registradas;
  4–7 y los controles server-side no se dan por probados por el simulador.
- [ ] **WAITING — checkpoint de aceptación persistente:** fijar target,
  dos cuentas de prueba aisladas, archivos exactos, máximo
  **dos avatares nuevos**, conservación/retirada posterior y autorización de
  las escrituras. No reutilizar autorizaciones H5/Sitting como permiso GLB.
  Revisar antes los permisos de las muestras para ese destino: una descarga
  pública no equivale a permiso comercial o de redistribución.
  Si se usa producción: checkpoint conjunto DB + medios válido antes de
  subir/guardar, según `deployment/create-checkpoint.sh`, sin restore de ensayo.
  No crear staging para salvar este paso sin una decisión separada de coste.

**Hallazgo del inventario:** `hubs/src/assets/models/DefaultAvatar.glb`
(829504 bytes, SHA-256
`ae8b624db8d7d713fb51b73159a228c4686210dc647fa826864ba11600af8abc`)
y `hubs-cloud/community-edition/services/reticulum/test/fixtures/test.glb`
son rigs legacy sin hombros/brazos/antebrazos requeridos por el importador actual.
No se usarán como positivos ni se rebajará el validador para hacerlos pasar.
Esto no demuestra que el avatar legacy ya guardado deje de funcionar.
Los clips Mixamo tampoco sustituyen un avatar full-body. No se usan archivos
de `OLD/` como entrada activa ni se buscan archivos personales fuera del alcance.

### G2 — Ejecutar la aceptación

- [ ] Con G1 cerrado, completar los siete criterios; anotar por caso archivo,
  fuente/digest, navegador/cuenta, resultado y evidencia no sensible.
- [ ] Readback final de los dos avatares y sus listados, y cierre de sesiones.
  Registrar si los avatares de prueba se conservan; no borrar automáticamente.

### G3 — Corregir únicamente si hay fallo

- [x] Causa local G1 corregida y focal verde; no se cambió rig, límite de
  tamaño, API, schema, permisos, listados ni datos persistidos.
- [x] Segunda causa local: cámara basada en vértices sin skin y encuadre solo
  vertical. Corrección aislada en preview/utilidad, sin cambiar los modelos;
  validación geométrica y visual local descrita en la evidencia de muestras.
- [x] Candidata congelada en Hubs `e83adaf38`; sección afectada validada una
  vez con 119 unidades, builds Hubs/Admin y recibo exacto. No se repite.
- [x] Publicar e integrar Hubs PR #7 tras sus checks oficiales verdes:
  `master=668413a20`.
- [x] Integrar el gitlink raíz exacto y los documentos mediante PR #22:
  `main=4f3d91a17`. Los checks proporcionales pasaron; se detuvo únicamente la
  repetición de recovery fuera de alcance.
- [x] Construir desde Hubs `master=668413a20` por el workflow oficial.
  Actions `33504152150` terminó verde y publicó
  `ghcr.io/yengalvez/hubs@sha256:04544546d59a43703c536a63ea09a32c3f51f90f8c2e97109d788499f65f672f`.
  No ejecutar ahora el hook global de commit de Hubs como sustituto de esos
  archivos: relanzaría toda la unidad aunque el bloque actual solo es focal.
- [x] Crear y validar antes del rollout el checkpoint conjunto DB + medios en
  `/Users/yengalvez/.yenhubs-private/glb-rollout-20260901/checkpoints/checkpoint-pre-668413a20`.
  Conserva 361 tablas, 100 migraciones, 18 hubs y los 33 pares de medios; los
  cinco escritores se reanudaron y la Lease quedó libre.
- [x] Aplicar por el driver protegido la generación de 44 recursos
  `cold-rebind-legacy-active-v1`. El diff previo excluyendo Secrets cambia solo
  la imagen Hubs y la huella de imágenes del Namespace; los dos Secrets
  generados coinciden en claves y valores con producción.
  El primer apply publicó Hubs y después se cerró fail-closed: la marca
  operativa heredada `kubectl.kubernetes.io/restartedAt` de Reticulum era el
  único campo distinto en los doce snapshots. El clúster quedó con Hubs nuevo
  listo, PostgreSQL listo, cinco escritores a cero, Lease libre y sin lock de
  recuperación. Reparación causal: retirar solo esa marca que el manifiesto no
  contiene, repetir una vez el mismo apply y añadir una regresión permanente al
  comparador; no se regeneró, recapturó ni cambió otra entrada. Tras retirar
  con UID/resourceVersion la única marca, el reintento causal terminó verde y
  dejó 12/12 Deployments listos y la Lease libre.
- [x] Reiniciar Reticulum tras Hubs, ejecutar el verificador live y comprobar
  carga fría sin subir ni guardar los GLB de muestra. El diff posterior fue
  cero y el verificador final terminó con **0 fallos / 0 avisos**, DB
  361/100/18/33 y medios 33/33. Escritorio y móvil cargan el bundle nuevo sin
  errores; el vestíbulo privado no demuestra todavía entrada visible en sala.
- [x] Corregir los dos huecos operativos revelados por el rollout: Cloud PR
  #30 validó el marcador `restartedAt` y PR #31 lo promovió a
  `master=43210079d`; el verificador legacy acepta cero salas bot solo si todo
  el payload vacío sigue siendo exacto y coherente.
- [ ] Si G2 revela otro fallo: conservar diagnóstico exacto y corregir solo
  la causa. Si no, no añadir otra corrección. Un cambio de contrato requiere
  revisar la decisión, no adaptar el test para que pase.
- [ ] Solo si cambian bytes de producto: usar las secciones afectadas del
  verificador y el procedimiento de build/digest/rollout de
  `deployment/README.md`, bajo el alcance de publicación/producción autorizado.
  No tocar nube por una corrección meramente documental.

### G4 — Cerrar sin otra ronda general

- [x] Publicar evidencia no sensible de los criterios cerrados y residuos reales
  en estos documentos; la feature no se marca completa por fuente/unitarios.
- [x] Integrar el puntero Cloud, verificador, estado humano y changelog tras
  inspeccionar diff, enlaces y secretos. La PR raíz #24 dejó `main=7fcda31b`
  con Hubs `668413a20` y Cloud `43210079d`; no se ejecutó otro `--full`.
- [x] Terminar este bloque: no crear otro Goal, heartbeat, auditoría o tarea
  automáticamente. G2 permanece pendiente y requiere una decisión humana nueva.

## Próximo paso y parada

**Siguiente:** devolver el control antes de G2. El rollout de código está
operativo, verificado e integrado; no hay suite, build, apply ni monitor en
marcha. Entrar de forma visible en la sala y guardar hasta dos GLB con dos
cuentas son efectos separados que siguen pendientes. No se convierte este
rollout en un cierre ficticio de G2.

Se continúa sin preguntas entre comprobaciones locales reversibles.
Se pide solo lo que falte para una acción concreta: permisos de uso donde sean
necesarios, cuentas/target y escrituras de la sesión; no pedir al propietario
que busque estas muestras. Una autorización específica vale
para toda esa sesión mientras no cambien datos, destino, riesgo ni coste.
Una divergencia de identidad, secreto expuesto, pérdida de estado seguro o
fallo sin causa demostrable detiene los efectos, no reabre H5.
