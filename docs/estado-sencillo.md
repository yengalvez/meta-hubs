# Estado sencillo de YenHubs

Ultima actualización: **26 de agosto de 2026**

## Respuesta corta

La recuperación ya ha terminado bien. YenHubs está activo otra vez con su base
de datos y sus medios originales. El verificador de producción terminó con
**0 fallos y 0 avisos**, y la batería local final pasó **894 de 894 pruebas**.
No hace falta repetir otro restore ni volver a crear DigitalOcean.

H5 está cerrado. El código exacto que hizo posible la recuperación quedó
integrado, los recibos corresponden a los bytes finales y la aceptación humana
está completa. El siguiente trabajo vuelve a ser desarrollar features.

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
- Cloud quedó integrado en `6d9ee9e`; el PR raíz #18 integró el gitlink y el
  cierre H5 en `main`.

## Por qué H5 ya está cerrado

El finalizador exigió submódulos integrados y limpios, gitlinks exactos y todos
los recibos vigentes. Cloud pasó #25, #26 y #27; la raíz pasó #18. La única
diferencia del runner fue un falso positivo de ShellCheck 0.10 en una función
de `trap`; se acotó al workflow y no cambió la lógica de recovery.

Las tres acciones que no debe fingir una prueba automática ya han pasado:
avatar real, chat privado y audio bidireccional con dos participantes.

## Lo que toca ahora

1. Volver a desarrollar features.
2. Mantener este recovery como capacidad operativa, sin reabrir H5 salvo que
   cambien sus requisitos o aparezca evidencia nueva.

## Qué no se va a hacer

- No habrá otro restore, checkpoint, clúster ni copia nueva.
- No se mezclará la imagen durable moderna con el restore histórico.
- No se repetirán las 894 pruebas mientras sus bytes no cambien.
- No se tocarán costes, topología o secretos para cerrar esta fase.

## Cuánto queda

No queda trabajo de H5. La recuperación, la aceptación humana, los recibos y la
integración están resueltos. Lo siguiente es producto y features.

## Cuándo se para

Solo ante una identidad distinta, lock/Lease ambiguos, pérdida del estado
seguro, exposición de un secreto, un cambio de coste/topología no previsto o un
fallo grave que necesite investigación superior. Un fallo normal no abre otro
proyecto: se corrige únicamente su causa demostrada.
