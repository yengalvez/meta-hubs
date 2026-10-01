# Canal de módulos y hook de chat montado · 01/10/2026

Registro del candidato, subordinado al único
[plan activo](/Users/Shared/Gits/YenHubs/PLAN/Plan_activo.md) y al
[contrato de aceptación](/Users/Shared/Gits/YenHubs/DOC/fiabilidad-operativa-yenhubs-2026-10-01.md)
canónicos; no se copian sus fuentes de autoridad al worktree.
Cierra una frontera local del cliente, no el objetivo completo ni un rollout.

## Pregunta y fuente real

Después del arreglo de [configuración cacheada](/Users/Shared/Gits/YenHubs/DOC/fiabilidad-config-cache-2026-10-01.md),
se comprueba otra frontera distinta: el mensaje ON/OFF del canal de sala
recibido por un hook React ya montado. El control debe entregar una respuesta
y su aviso de acción válido; OFF debe abortar una respuesta retenida, impedir
envíos mientras está apagado y no revivir la respuesta al volver a ON.
Una petición nueva después de ON debe seguir funcionando.

Se añaden exactamente dos casos al archivo normal
`hubs/test/unit/react-components/use-bot-chat-request.test.js`, ya incluido
por `test:unit`/AVA. Usan el HubChannel actual, un Channel real de Phoenix,
su despacho `on/trigger`, React18 y el hook `useBotChatRequest` actual en
JSDOM. El socket nunca conecta ni hace join. La dependencia TS de migración
queda sin cargar mediante el mismo seam de las unidades previas de HubChannel:
esta prueba no migra sockets ni monta el store global.

El transporte de chat es una promesa sintética retenida, con el AbortSignal
real de la petición del hook. `sendingDisabled` del padre se modela de forma
explícita después del aviso OFF; no se presenta como UIRoot ejecutado.
El hook solo presenta el aviso de acción: no ejecuta movimiento ni demuestra
la cancelación autoritativa de órdenes del backend.

## Evidencia terminal

| Sesión | Resultado real | Alcance |
| --- | --- | --- |
|48227|exit0, TAP2/2,0fallos|Solo los dos nombres nuevos; control y OFF→ON|
|50422|exit0, formato AST equivalente y ESLint PASS|Solo el archivo modificado|
|77722|exit0, TAP1/1,0fallos; formato y ESLint PASS|Solo control positivo refinado|

La revisión primaria separada reforzó solo el control: una respuesta válida
incluye un aviso visible de acción, para que la ausencia de un aviso antiguo
no sea un oracle vacío. El caso negativo siguió compatible y no se repitió;
los tres casos previos con FakeHubChannel tampoco se ejecutaron.
La revisión no es independiente: la ruta de herencia/modelo del principal
no estaba verificada para delegación. No se abrió una auditoría general.

El caso negativo exige epoch mayor al apagar y al encender, señal antigua
abortada, estado sending apagado, ningún request adicional durante OFF,
ninguna respuesta/aviso antiguos después de ON y exactamente una respuesta
válida nueva con otro AbortSignal. No se ha encontrado un defecto nuevo en
la fuente de producto de este bloque: el cambio es solo de regresiones.

## Seguridad y límites

Scratch propio0700 `/private/tmp/ynhub-ui-Y6sBso`; logs0600
`ava.log`, `gates.log` y `control-final.log`. Entorno limpio, HOME/TMP/cache
privados, Babel y AVA sin escribir caché en el checkout, sandbox de macOS con
toda red denegada. Node22.11/AVA4.3.3/React18.2/Phoenix1.5/JSDOM20.0.3 son
herramientas existentes. Package/lock/Babel/shim coinciden con F cacheado,
usado solo para resolver dependencias; no se instaló ni editó F.
Las tres sesiones son terminales, no procesos por vigilar.

No prueba WebGL, APP/AFRAME, cold browser, UI completa, SQL→HTTP→socket,
Presence/autenticación remota, seis instalaciones completas, proveedor,
STOP/movimiento ni tres ciclos copia→restore→deploy/rollback representativos.
No cambian producción, datos33 GLB/miniaturas,7 IDs, guardas de recuperación,
Cloud, imágenes o generador. El full exacto, integración en bases y aceptación
real siguen pendientes al congelar el candidato completo. El objetivo sigue
ACTIVE; no se infiere aprobación del checkpoint Kubernetes pendiente.
