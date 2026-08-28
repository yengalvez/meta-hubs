# Estado sencillo de YenHubs

Ultima actualización: **28 de agosto de 2026**

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

La parte local de Sitting v2 ya está cerrada. No ha hecho falta reprogramar la
feature:

- browser: **11/11** unidades y un único E2E Sitting enumerado, sin abrir una
  URL remota;
- Hubs: TypeScript, lint dirigido y **48/48** pruebas Sitting;
- Reticulum: dependencias locked, format, compilación estricta y **20/20**
  pruebas contra PostgreSQL local;
- composición: **2/2** gitlinks, diff-check y los tres árboles limpios.

Las fuentes candidatas quedan congeladas en Hubs `ce8390a` y Cloud/Reticulum
`6d9ee9e`. No se cambió código de producto y no se repitió el `--full`.

Lo siguiente ya no es otra ronda local: hace falta autorizar la inspección
externa/build y concretar un staging aislado. Después se construyen únicamente
Hubs y Reticulum, se prueba la carrera con dos navegadores y, solo si pasa, se
propone la ventana productiva.

El workspace nuevo es `/Users/Shared/Gits/YenHubs-features`, está en la rama
local `codex/sitting-v2` y conserva los gitlinks exactos. Los worktrees
antiguos no se han limpiado, reutilizado ni borrado.

El código autoritativo ya existe en Hubs y Reticulum. Producción conserva los
commits anteriores y solo demuestra sitting histórico; la carrera v2 todavía
necesita build, staging y aceptación antes de cualquier promoción.

El hardening operativo nuevo está en una rama local. Publicarlo más adelante
no es requisito para que el metaverso actual funcione ni para empezar features.

## Qué no se va a hacer

- No habrá otro restore, checkpoint, clúster ni copia nueva.
- No se mezclará la imagen durable moderna con el restore histórico.
- No se repetirán las 894 pruebas mientras sus bytes no cambien.
- No se repetirá el `--full` posterior: sus fallos ya tienen diagnóstico y
  focales exactas verdes.
- No se tocarán costes, topología o secretos para cerrar esta fase.

## Cuánto queda

**0 % de H5 pendiente.** Validación, recuperación, producción, aceptación
humana, CI, gitlinks y merge están resueltos.

La preparación para features está **100 % terminada**. En Sitting v2, la fuente
y su validación local están terminadas. La feature comercial aún necesita los
builds trazables, staging de dos navegadores y aceptación productiva. No se
convierte source existente en un porcentaje live ficticio.

## Cuándo se para

Solo ante una identidad distinta, lock/Lease ambiguos, pérdida del estado
seguro, exposición de un secreto, un cambio de coste/topología no previsto o un
fallo grave que necesite investigación superior. Un fallo normal no abre otro
proyecto: se corrige únicamente su causa demostrada.
