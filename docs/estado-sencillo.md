# Estado sencillo de YenHubs

Ultima actualización: **22 de agosto de 2026**

## Respuesta corta

La hibernación no se ha perdido ni hay que empezar de nuevo. El bundle conjunto,
las copias cifradas, la recreación de DigitalOcean, DNS, certificados y el
preflight cold-rebind están terminados. La infraestructura nueva sigue parada de
forma segura esperando un único restore.

El problema detectado era el método de pruebas: un comando enorme se detenía en
el primer fallo y obligaba a volver a recorrer horas de resultados verdes. Esa
política se ha retirado del plan.

## Qué está preparado ahora

- `PLAN_ACTUAL.md` v9.4 es la única cola de trabajo.
- `scripts/verify-project.sh` está rediseñado por secciones.
- Las auditorías baratas se sitúan antes de las suites largas.
- Cada sección puede guardar un recibo privado ligado a sus entradas, a su
  propio comando, al núcleo común, solo a las herramientas que usa y al log. Un
  cambio en otra sección o en otra toolchain no lo invalida.
- Un PASS exacto podrá reutilizarse y un cambio en Dialog no invalidará recovery
  ni H5.
- El arnés continuará con las demás secciones aunque una falle, para descubrir
  todos los problemas en una sola pasada.

El arnés ya pasó su validación mecánica: sintaxis, ShellCheck, prueba focal
`12/12`, privacidad/tamper de recibos y `git diff --check`. Después se
ejecutaron solo Dialog y la cola independiente M3; recovery/H5 y el `--full` no
se repitieron.

## Evidencia anterior que sigue cerrada

- recovery normal `871/871`;
- H5 `173/173`;
- HCCE generator `32/32`;
- `test:apply` `120/120`;
- bot-orchestrator `155/155`;
- Hubs/Admin y navegador/capacidad verdes en el candidato anterior;
- ninguna mutación productiva durante esos gates.

No se fabricarán recibos retroactivos. Para el finalizador estricto se hará una
única captura v2 seccionada: cada PASS quedará conservado aunque otra sección
falle, de modo que nunca se reinicie la batería completa.

## Lo que queda

1. Dialog ya está cerrado: `tar` quedó en `7.5.21`, la imagen no instala
   devDependencies y advisories/lint/tests pasan.
2. Photomnemonic, Coturn, Spoke, static, security y composition ya pasan.
   Reticulum también pasa funcionalmente: **461 tests, 5 properties y 0
   fallos** usando el usuario local de pruebas existente `yengalvez`.
   El advisory nuevo de Cowlib ya tiene solución preparada: pin exacto al
   parche oficial, guarda online Hex+Git que falla ante cualquier alerta nueva
   y una regresión directa de la vulnerabilidad. No se ha ejecutado aún la
   validación mecánica final de esos bytes.
3. Los recibos pasan a schema v2. El cambio invalida una vez la evidencia v1,
   pero desde ahora una corrección local solo invalida su propia sección. No se
   fabrican recibos ni se vuelve al full monolítico.
4. Primero se validan advisories, Reticulum, static y composition, más el foco
   pequeño de Cowlib. Después se crean una sola vez los recibos v2 faltantes;
   el despachador conserva cada verde y una reparación solo repite su sección.
5. Se realiza un único restore coordinado y una aceptación comercial en
   navegador frío.
6. Se integran Hubs Cloud y root y H5 termina.

## Regla humana

No importa que todas las pruebas ocurran dentro del mismo proceso. Importa que
cada cobertura obligatoria esté verde sobre las entradas correctas, que la
evidencia no esté caducada, que no queden procesos residuales y que el restore y
el navegador demuestren el producto real.

La historia detallada de los intentos anteriores permanece en
`docs/session-changelog.md` y `docs/auditoria-final-h5-2026-08-20.md`; no dirige
la siguiente acción.
