# PLAN ACTUAL — terminar H5 sin repetir trabajo verde

Version: **v9.4; M1/M2 cerrados y solución M3 preparada**
Estado: **pin seguro de Reticulum implementado; la siguiente fase es únicamente validación mecánica acotada**
Ultima revision: **22 de agosto de 2026 (Europe/Madrid)**
Autoridad: **este es el único plan ejecutable**. Los planes anteriores y
`docs/auditoria-final-h5-2026-08-20.md` son evidencia histórica, no colas de
trabajo.

## Resultado humano

Terminar una única demostración comercial de hibernación y reactivación:

1. conservar conjuntamente PostgreSQL y los medios de `ret-pvc`;
2. retirar los recursos facturables de una instancia;
3. recrear la topología autorizada con identidades Kubernetes nuevas;
4. restaurar DB y medios una sola vez;
5. demostrar en navegador frío que el metaverso vuelve a funcionar.

Al cerrar esos cinco resultados termina H5 y el trabajo vuelve a features. No
se abre otra arquitectura recovery, otra hibernación ni otro restore dentro de
este plan.

## Estado comercial ya demostrado

- [x] Bundle `freeze-bundle-v1` conjunto y válido: DB, medios, inventarios,
  receta, digests y checksums.
- [x] Dos copias cifradas reabiertas y rehasheadas; recibo privado `0600`; 13
  imágenes custodiadas.
- [x] Retirada selectiva anterior del cluster, nodo, Load Balancer y dos
  volúmenes; el recurso ajeno `voice-chat` se conservó.
- [x] Infraestructura equivalente recreada en `ams3`: Kubernetes
  `1.34.10-do.1`, HA desactivada, un nodo `s-4vcpu-8gb`, LB regional y dos PVC
  de 10 GiB.
- [x] DNS y certificados `4/4`.
- [x] Perfil `cold-rebind-legacy-absent-v1` generado y aplicado; preflight live
  read-only verde.
- [x] Estado live fail-closed conservado: cinco writers a cero, DB destino sin
  tablas de aplicación, lock `checkpoint-restore/cold-rebind` retenido y Lease
  libre.

## Evidencia local cerrada que no se repite

Los siguientes resultados pertenecen a superficies que no han cambiado por el
hallazgo de Dialog ni por el rediseño del orquestador. Se conservan como
evidencia de transición H5 y no se convierten artificialmente en recibos v2:

- recovery normal `871/871`;
- agregado H5 `173/173`;
- Hubs CE generator `32/32`;
- `test:apply` `120/120`;
- bot-orchestrator `155/155`;
- Hubs/Admin y navegador/capacidad alcanzados verdes por el último candidato.

Los logs privados y las causas de los intentos anteriores están indexados en
`docs/session-changelog.md` y `docs/auditoria-final-h5-2026-08-20.md`. No se
copian otra vez aquí.

## Corrección del método de validación

El `--full` antiguo era monolítico, `fail-fast` y utilizaba suites largas para
descubrir un fallo cada vez. Esa política queda retirada.

El arnés nuevo de `scripts/verify-project.sh` debe ofrecer:

- secciones independientes con los mismos comandos de cobertura;
- auditorías de dependencias antes de las suites largas;
- continuación entre secciones aunque una falle;
- logs y recibos privados, atómicos y ligados a la clausura de entradas de cada
  sección, al arnés y al toolchain;
- caducidad de 24 horas para advisories;
- reutilización automática de un PASS exacto;
- invalidación solo de la sección afectada y sus dependientes;
- una sección corta de composición y un finalizador que compruebe recibos,
  gitlinks, diffs y ausencia de procesos residuales.

Un cambio transversal, una clausura desconocida, toolchain distinto,
advisories caducados, log incompleto o contaminación del host invalida la
evidencia correspondiente. Una modificación exclusiva de Dialog no invalida
recovery ni H5.

## Plan de producción

### M1. Validar el nuevo arnés seccionado

- [ ] Revisar el diff de `scripts/verify-project.sh` y
  `tests/scripts/verify-project-sections.test.sh`.
  - Estado: **cerrado y validado**.
  - No ejecutar ninguna suite de producto ni `--full` durante esta revisión.
  - Confirmar que `scripts/verify-project.sh` conserva modo ejecutable; si la
    sustitución del fichero lo perdió, restaurar únicamente ese bit antes de
    validar.
- [x] Ejecutar únicamente:

  ```bash
  bash -n scripts/verify-project.sh tests/scripts/verify-project-sections.test.sh
  shellcheck -x scripts/verify-project.sh tests/scripts/verify-project-sections.test.sh
  bash tests/scripts/verify-project-sections.test.sh
  git diff --check
  ```

  - Resultado: `bash -n` PASS, ShellCheck PASS, arnés focal `12/12` PASS y
    `git diff --check` PASS. La sustitución del script conserva modo `0755`.
  - STOP aplicado una sola vez a cuatro advertencias de ShellCheck y cuatro
    espacios finales del plan; se corrigieron únicamente esas causas y no se
    repitió ninguna suite de producto.

**Cierre M1:** CLI, fingerprint, privacidad, tamper y caducidad del recibo
verificados; cero suite larga ejecutada.

### M2. Resolver la alerta productiva de Dialog — cerrado

- [x] Confirmar que `mediasoup@3.19.22` declara `tar ^7.5.13` y que la versión
  corregida elegida sigue dentro de ese rango.
- [x] Actualizar únicamente la resolución transitiva de `tar` en el lockfile de
  Dialog. Prohibidos `npm audit fix --force`, upgrade general de Mediasoup y
  cambios de aplicación sin una causa distinta.
- [x] Mantener las dependencias de desarrollo fuera de la imagen runtime de
  Dialog (`npm ci --omit=dev`); los avisos de ESLint no deben viajar al cliente.
- [x] Revisar que el diff del lockfile no actualiza paquetes ajenos.
- [x] Ejecutar, usando un único directorio privado de evidencia:

  ```bash
  ./scripts/verify-project.sh --section advisories --evidence-dir <DIR_PRIVADO_0700>
  ./scripts/verify-project.sh --section dialog --evidence-dir <MISMO_DIR>
  ```

**Cierre M2:** `advisories` PASS, `dialog` PASS; el lock solo cambia
`tar@7.5.20` a `7.5.21`, la imagen usa `npm ci --omit=dev`, y lint/tests de
Dialog pasan. El audit completo del entorno de test aún enumera dependencias de
desarrollo antiguas, pero no se copian al runtime y no abre una deuda productiva
distinta.

### M3. Completar únicamente la cola que el full nunca alcanzó — parcialmente cerrado

- [x] Ejecutar una sola vez y en el mismo directorio de evidencia:

  ```bash
  ./scripts/verify-project.sh --section photomnemonic --evidence-dir <DIR>
  ./scripts/verify-project.sh --section coturn --evidence-dir <DIR>
  ./scripts/verify-project.sh --section spoke --evidence-dir <DIR>
  ./scripts/verify-project.sh --section reticulum --evidence-dir <DIR>
  ```

  Resultado: `photomnemonic`, `coturn` y `spoke` PASS. La primera ejecución de
  `reticulum` quedó bloqueada por dos causas independientes: `mix hex.audit`
  detectó el advisory nuevo de `cowlib 2.19.0` (`EEF-CVE-2026-43971`) y el
  arnés imponía el usuario local `postgres`, que no existe en este Mac.

  La causa local ya está resuelta como evidencia de entorno, sin modificar
  producto ni producción: con el rol existente `yengalvez` (superusuario local
  de pruebas), Reticulum pasó **461 tests, 5 properties y 0 fallos**. El arnés
  productivo conserva deliberadamente `DB_CREDENTIALS=postgres`; no se cambia
  esa configuración por conveniencia local.

  El bloqueo detectado era upstream: la CNA marca afectadas las versiones
  Hex desde `2.9.0` y enlaza el commit `89da27e` como parche, mientras Hex sigue
  marcando `2.19.0` como vulnerable y no publica una release corregida. No se
  añade `CVE-2026-43971` a `ignore_advisories`. El propietario autorizó resolver
  la unidad y se eligió el pin exacto al commit oficial `89da27e`, acompañado de
  una guarda específica para que convertir Cowlib en dependencia Git no deje
  ciego a `mix hex.audit`.

  Como preparación no mutante, se probó ese commit en una copia desechable del
  servicio: `mix deps.get`, formato y compilación estricta pasan; `mix
  hex.audit` queda sin paquetes retirados ni advisories (solo advierte que las
  dos entradas antiguas ya no aplican al paquete Git), y el foco de 4 pruebas
  de CORS pasa. La suite completa desechable tuvo un único timeout de socket en
  ese mismo foco; al aislarlo pasó `4/4`, por lo que no se atribuye a cowlib.
  Esto demostró la viabilidad técnica previa del pin.

- [x] Implementar la solución de procedencia y seguridad, sin ejecutar todavía
  la fase mecánica:
  - `mix.exs` y `mix.lock` fijan el repositorio oficial y el SHA completo;
  - la guarda nueva comprueba lock, checkout, ancestro 2.19.0 y los tres commits
    exactos posteriores al tag;
  - OSV debe seguir ligando `CVE-2026-43971` al SHA parcheado y devolver
    exactamente el conjunto conocido para Hex 2.19.0; toda alerta nueva falla;
  - `mix hex.audit` continúa cubriendo todas las demás dependencias Hex;
  - un ExUnit focal prueba un Link válido y rechaza inyección por target, `rel`
    y clave de atributo;
  - la auditoría se ejecuta en la sección `advisories`, cuyo recibo caduca a las
    24 horas, y no dentro de los 461 tests de Reticulum.

- [ ] Ejecutar una sola vez, en este orden y en un mismo directorio privado:

  ```bash
  bash -n scripts/verify-project.sh tests/scripts/verify-project-sections.test.sh \
    hubs-cloud/community-edition/services/reticulum/scripts/verify-cowlib-security-contract.sh
  shellcheck -x scripts/verify-project.sh tests/scripts/verify-project-sections.test.sh \
    hubs-cloud/community-edition/services/reticulum/scripts/verify-cowlib-security-contract.sh
  bash tests/scripts/verify-project-sections.test.sh
  cd hubs-cloud/community-edition/services/reticulum
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix deps.get --only test --check-locked
  mise x erlang@27.3.4.14 elixir@1.18.4-otp-27 -- \
    env MIX_ENV=test mix test test/cowlib_security_contract_test.exs
  cd ../../../..
  ./scripts/verify-project.sh --section advisories --evidence-dir <DIR>
  YENHUBS_RETICULUM_TEST_DB_CREDENTIALS=yengalvez \
    ./scripts/verify-project.sh --section reticulum --evidence-dir <DIR>
  ./scripts/verify-project.sh --section static --evidence-dir <DIR>
  ./scripts/verify-project.sh --section composition --evidence-dir <DIR>
  ```

  Si falla una orden, corregir solo esa causa y repetir únicamente la sección o
  foco cuya entrada haya cambiado. No iniciar el despachador completo hasta que
  esta unidad quede verde.

- [ ] Crear una sola vez los recibos v2 que falten y finalizar. Esta es la
  única repetición amplia restante: no reabre decisiones ni borra los PASS que
  vaya obteniendo. El `--full` actual es un despachador seccionado, continúa
  ante fallos y reutiliza automáticamente los recibos exactos ya creados:

  ```bash
  ./scripts/verify-project.sh --full --evidence-dir <MISMO_DIR>
  ./scripts/verify-project.sh --finalize --evidence-dir <MISMO_DIR>
  ```

  Si una sección falla, conservar todos los otros recibos, corregir la causa y
  ejecutar solo `--section <fallida>` antes de repetir exclusivamente el
  finalizador. Nunca reiniciar la batería completa.

- [x] Por el cambio del propio arnés, ejecutar solo sus dependientes:

  ```bash
  ./scripts/verify-project.sh --section static --evidence-dir <DIR>
  ./scripts/verify-project.sh --section security --evidence-dir <DIR>
  ./scripts/verify-project.sh --section composition --evidence-dir <DIR>
  ```

  Resultado: `static`, `security` y `composition` PASS. La primera ejecución
  de `composition` fue invalidada porque el runner ocultaba el fallo de cwd y
  status; tras corregirlo, la única repetición `composition` generó y verificó
  `68` recursos correctamente.

- [x] Registrar la matriz H5 de transición: recibos nuevos para las secciones
  anteriores y evidencia histórica cerrada para recovery/H5/Hubs/browser/HCCE/
  bot. No fabricar recibos retroactivos ni ejecutar esos bloques de nuevo.

**Cierre M3:** la decisión y el código están cerrados; falta solamente validar
los bytes finales del pin, la guarda, la regresión y las secciones invalidadas.
No se abre otro full para ello.

**Frescura de recibos:** el schema v2 liga cada recibo al núcleo común, al
comando y al toolchain de su propia sección, no al fichero completo del arnés ni
a herramientas ajenas. Este cambio invalida una sola vez los recibos v1;
después, un ajuste en Reticulum o advisories no vuelve a invalidar recovery,
H5, Hubs ni otras secciones cerradas. No se fabrican recibos retroactivos.

### M4. Completar una única restauración productiva

- [ ] Recapturar read-only contexto, topología, Namespace/PVC, cinco writers,
  DB, Pods, lock y Lease; comparar con el estado fail-closed autorizado.
- [ ] Limpiar una sola vez el lock stale exacto mediante el flujo
  `RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1` y `RESTORE_TARGET_MODE=cold-rebind`.
- [ ] Repetir inmediatamente el preflight cold-rebind read-only.
- [ ] Ejecutar un único restore coordinado de DB y medios y medir RTO.

**Cierre M4:** DB y medios validados, cinco writers reanudados en orden, lock y
Lease liberados.
**STOP:** identidad/topología/coste distintos, Lease ocupada, lock no exacto,
respuesta ambigua o fallo. No se lanza un segundo restore en este plan.

### M5. Aceptar el producto real e integrar

- [ ] Conservar `0 failures / 0 warnings` del verificador live ejecutado por el
  restore; repetirlo solo si no quedó evidencia o cambió el estado.
- [ ] En navegador interno frío comprobar español, login, `VJopCY3`, dos
  participantes y audio bidireccional, cámaras primera/tercera persona, avatar,
  Admin, Spoke, sitting legacy, escena y medios sin excepciones first-party.
- [ ] Recuperar evidencia histórica de coste solo si sigue disponible; no
  repetir una hibernación para fabricarla.
- [ ] Integrar primero Hubs Cloud y después el gitlink/root siguiendo
  `docs/development-workflow.md`.
- [ ] Actualizar `docs/estado-sencillo.md` y `docs/session-changelog.md`, cerrar
  H5 y volver a features.

## Fuera de alcance

- otro checkpoint, otra copia cifrada, otro borrado o recreación de DO;
- otro restore, salvo una nueva autorización tras un STOP real;
- nuevas matrices o arquitectura recovery;
- HA, HPA, Terraform, multi-cliente self-service o modernización upstream;
- hotpatches, `kubectl scale`, manifiestos editados a mano o hijos restore
  ejecutados por separado.

## Reglas anti-loop

1. Un PASS exacto se reutiliza; no se repite para aumentar confianza.
2. Un FAIL solo se repite después de una causa demostrada y un cambio relevante.
3. El arnés recopila todos los fallos independientes en la misma pasada.
4. Una sección cambia solo la evidencia de su clausura y dependientes.
5. Los audits caducan; las suites funcionales no caducan mientras sus entradas y
   toolchain permanezcan idénticos.
6. No se vuelve a exigir un `--full` monolítico para cerrar H5.
7. El resultado comercial lo demuestran el restore y el navegador, no el número
   de tests.
8. El historial vive en el changelog/auditoría; este plan conserva solo estado,
   dependencias, próximos pasos y evidencia necesaria para reanudar.

## Punto de menor confianza

La decisión difícil ya está resuelta sin silenciar advisories. La incertidumbre
restante es puramente verificable: confirmar que los bytes finales pasan la
guarda online, la regresión `cow_link`, Reticulum y el release/CI. Hasta esos
verdes el cambio no se integra ni se usa para construir una imagen productiva.
