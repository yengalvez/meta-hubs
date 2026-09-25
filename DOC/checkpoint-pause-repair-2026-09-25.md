# Recuperación limitada del backup del 25 de septiembre

## Resultado y límites
El dueño autorizó explícitamente recuperar la pausa fallida, conservar la misma
versión y continuar después con la publicación de avatares. El coordinador
Cloud `apply/recover-avatar-checkpoint.js` está fijado a esa incidencia y requiere
un plan privado confirmado por hash. No es un restaurador ni una vía general
de despliegue. No modifica datos, imágenes, credenciales o políticas de acceso.

La ejecución terminó exit 0: 12/12 Deployments listos, bloqueo eliminado mediante
UID/RV, Lease libre y HTTP 200. El verificador live terminó 0 fallos/0 avisos.
Un navegador interno frío cargó la escena y mostró bots. Se conservaron DB y
medios (61 pares verificados); no se publicó aún ningún avatar ni cliente nuevo.

## Causas verificadas y reparación
1. El monitor usaba el resourceVersion de objetos inmutables como cursor inicial
   de Watch. Prueba real read-only: Namespace RV11863813 devuelve ERROR410 Expired;
   el cursor de un LIST actual cierra correctamente. Los items del LIST real
   omiten TypeMeta. Se usa ahora LIST completo filtrado por nombre, validando
   identidad exacta del objeto y tomando solo el cursor de la colección fresca.
   Un 410 posterior sigue siendo fallo; no se sustituye una ventana ya iniciada.
2. El reanudador exigía el binding dormido mientras el propio backup lo mantenía
   activo. La excepción nueva requiere capacidad de ese backup: Namespace,
   operación/lock UID/RV, Lease vigente y policy/binding UID/RV exactos, con
   comprobación antes y después. El verificador normal sigue exigiendo dormido.

20 pruebas del coordinador y 15 de verificación Cloud pasan; revisión
independiente y recheck pasan. Suite apply completa:191/191. Suite completa del
monitor:59/59. Gitleaks (root y Cloud), Actionlint y ShellCheck pasan.
La primera ejecución del fixture de checkpoint rechazó correctamente la fuente
sin commit antes de producir efectos; se repetirá con los cambios registrados.
El flujo de checkpoint limpio debe terminar antes de considerar reparado el
backup en vivo. Un plan o test no es una copia.

No usar el coordinador antiguo congelado basado en HMAC ni fabricar su autoridad.
No borrar fences ni relabelar el lock como restore. La fuente activa de producto
y la publicación de avatares se registran en el checkout YenHubs-avaturn,
DOC/rpm-catalog-2026-09-25.md. La reparación se mantiene separada del cliente.
