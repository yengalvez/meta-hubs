# Estado sencillo de YenHubs

Ultima actualización: **30 de agosto de 2026**

## Respuesta corta

La recuperación ya ha terminado bien. YenHubs está activo otra vez con su base
de datos y sus medios originales. El verificador de producción terminó con
**0 fallos y 0 avisos**, y la batería local final pasó **894 de 894 pruebas**.
No hace falta repetir otro restore ni volver a crear DigitalOcean.

La recuperación, la aceptación humana y la integración están terminadas. El CI
final `33073636287` pasó PostgreSQL 12.19/14.23, gitlinks, Gitleaks, Actionlint,
ShellCheck y las **894/894** regresiones de recovery. La PR raíz #18 se fusionó
en `main` como `feee36b`; Cloud y los dos punteros exactos están integrados.
**H5 está cerrado y el proyecto puede volver a features.**

La revisión operativa posterior también está cerrada localmente. El único
`--full` adicional no descubrió una rotura del metaverso: mezcló timeouts bajo
carga monolítica con un rol PostgreSQL local incorrecto. Los casos exactos de
recuperación pasan por separado y el verificador ahora conserva recibos para no
repetir secciones verdes. No se ha tocado producción para hacer esta corrección.

El plan de H5 se ha guardado completo en `OLD/docs/` y ya no dirige trabajo.
La transición corta ya creó un worktree limpio y corrigió los estados
documentales obsoletos. Se eligió **Sitting v2** y el nuevo `PLAN_ACTUAL.md`
dirige exclusivamente esa feature.

## Lo que ya está demostrado

- PostgreSQL conserva las tablas y conteos esperados.
- Los **33/33 pares de medios** están presentes.
- Los cinco servicios escritores están activos y saludables; PostgreSQL está
  `1/1`.
- El lock de recuperación está ausente, la Lease está libre y no quedan
  helpers, policies ni procesos de restore.
- DNS, TLS, HTTPS, Namespace, PVC e imágenes coinciden con el bundle restaurado.
- El ghost runner histórico está activo y la sala `VJopCY3` muestra cinco bots.
- Navegador frío: Home y sala cargan en escritorio y móvil, en español, sin
  excepciones first-party; `APP`, `AFRAME`, escena y medios inicializan.
- Primera y tercera persona, sitting histórico, Admin y el proyecto Spoke
  `qa3U3Ke` con escena `f6VKtim` se han comprobado.
- El catálogo muestra nueve avatares con sus thumbnails.
- Se seleccionó realmente el avatar neutral `base` y la sala confirmó el cambio.
- El chat privado y temporal con `bot-2` respondió correctamente al mensaje
  inocuo autorizado.
- Dos participantes estuvieron presentes; el micrófono local registró voz, el
  propietario confirmó que el audio se oía en ambos sentidos y terminó otra vez
  silenciado.
- Las secciones finales pasan sin ejecutar otro `--full`: recuperación
  `894/894`, H5 `174/174`, HCCE, composición, advisories, static, security y
  Reticulum.
- El finalizador confirmó los dos gitlinks y todos los recibos exactos.
- Cloud quedó integrado en `6d9ee9e`; la raíz `main` contiene los gitlinks
  exactos de Hubs `ce8390a` y Cloud `6d9ee9e` mediante el merge `feee36b`.

## Qué falta para cerrar H5

Nada. La plataforma funciona, el CI final está verde y la integración raíz está
fusionada. No se repite el restore ni se vuelve a abrir H5 sin requisitos o
evidencia nuevos.

Las tres acciones que no debe fingir una prueba automática ya han pasado:
avatar real, chat privado y audio bidireccional con dos participantes.

## Lo que toca ahora

**Sitting v2 ya está terminado y funcionando en producción.** Se desplegaron
exactamente las mismas imágenes que pasaron staging, primero Reticulum y después
Hubs. El clúster terminó con **12/12 servicios listos** y el verificador live
con **0 fallos y 0 avisos**.

En lenguaje humano, ya está demostrado todo el ciclo importante:

- dos personas intentan sentarse a la vez y solo una obtiene la silla;
- nunca aparecen dos concesiones privadas ni dos intervalos sentados solapados;
- ambos navegadores ven al ganador en la silla;
- al levantarse se libera, la otra persona puede ocuparla y el cierre abrupto
  también limpia la reserva;
- producción conserva la sala, la base de datos y los medios originales;
- el navegador frío carga en escritorio y móvil;
- en la sala real la silla quedó reservada, el avatar pasó a estado sentado,
  apareció el botón **Levantarse** y la pose se comprobó en tercera persona.

Antes de tocar producción se creó un checkpoint completo de base de datos y
medios, con checksums correctos. Sigue guardado en el área privada local como
rollback. No se cambió la topología de DigitalOcean ni se añadió coste mensual.

El staging ya se desmontó. La lectura final confirma ausencia del clúster, el
nodo, el balanceador, los dos discos y los dos firewalls exactos. Por tanto, el
**gasto adicional de staging está en cero** y DigitalOcean conserva únicamente
la topología productiva original.

Quedan cuatro registros DNS de staging apuntando a la antigua IP
`178.128.139.203`. No generan coste ni mantienen ningún servidor accesible. No
se borraron porque IONOS cerró la sesión y Google Password Manager pidió una
verificación física; no se forzó ni se cambió ninguna contraseña. Cuando IONOS
esté autenticado, se borran esos cuatro records exactos y se lee su ausencia.

El workspace nuevo es `/Users/Shared/Gits/YenHubs-features`, está en la rama
local `codex/sitting-v2` y conserva los gitlinks exactos. Los worktrees
antiguos no se han limpiado, reutilizado ni borrado.

Hubs ya está integrado en `master` como `0781a6309` y Cloud como `db083d53`;
la raíz fija esos dos punteros junto con esta documentación de cierre.

El siguiente trabajo ya puede ser otra feature. El único residuo operativo es
borrar cuatro DNS de staging que apuntan a una IP retirada; no sirven tráfico,
no cuestan dinero y no bloquean el producto.

## Qué no se va a hacer

- No habrá otro restore, recreación de staging ni repetición del rollout S5.
- No se mezclará la imagen durable moderna con el restore histórico.
- No se repetirán las 894 pruebas mientras sus bytes no cambien.
- No se repetirá el `--full` posterior: sus fallos ya tienen diagnóstico y
  focales exactas verdes.
- No se compartirán ingress, namespaces globales, datos ni credenciales con
  producción para ahorrar unos céntimos.

## Cuánto queda

**0 % de H5 pendiente.** Validación, recuperación, producción, aceptación
humana, CI, gitlinks y merge están resueltos.

**0 % de Sitting v2 pendiente.** Fuente, pruebas locales, builds, staging real,
E2E multiusuario, checkpoint, rollout productivo y aceptación visual están
terminados. El cleanup de cuatro DNS sin coste es mantenimiento menor, no parte
de la feature ni otro proyecto.

## Cuándo se para

Solo ante una identidad distinta, lock/Lease ambiguos, pérdida del estado
seguro, exposición de un secreto, un cambio de coste/topología no previsto o un
fallo grave que necesite investigación superior. Un fallo normal no abre otro
proyecto: se corrige únicamente su causa demostrada.
