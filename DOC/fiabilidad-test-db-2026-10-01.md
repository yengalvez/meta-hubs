# DB aislada del gate Reticulum · 01/10/2026

Subordinado al [plan canónico](/Users/Shared/Gits/YenHubs/PLAN/Plan_activo.md).
Este bloque permite ejecutar el gate normal sin utilizar el PostgreSQL local
existente del dueño. No es otra DB permanente, restore, perfil o backup.

## Mecanismo existente y cambio mínimo

Reticulum ya fija `DB_HOST=127.0.0.1`. Postgrex **0.22.4**, confirmado por
`mix.lock`, fuente cacheada y app cargada, obtiene su default de `PGPORT`
solo si ningún caller proporciona `port`. El adapter Ecto fijado introduce
5432 antes de Postgrex: el canary directo NO acreditaba los dos Repos.
La sección estándar33991 reprodujo esa diferencia; el sandbox bloqueó su
intento de conectar al5432 ajeno. Instancia propia detenida, sin consulta al
servidor del dueño ni fallo de copia multimedia inferido.

La reparación mínima añade el puerto canónico a los dos Repos y session lock
solo en la rama `:test` de `config/runtime.exs`. Default5432/rol/host conservados;
ramas dev/prod, esquema, plazos y permisos productivos intactos. No instalar
PostgreSQL, cambiar la red ni añadir un runner general para este requisito.

El driver root conserva ese mecanismo y default5432. Valida el puerto
canónico1–65535 antes de Mix, lo pasa explícitamente y lo incluye en el
material de recibo de Reticulum. Cambiarlo no conserva ese recibo; las otras
ramas del harness no incluyen este campo. Credentials siguen su contrato
previo de override/default local. Un puerto no prueba propiedad de la DB.

```bash
PGPORT=<puerto-propio-verificado> \
YENHUBS_RETICULUM_TEST_DB_CREDENTIALS=<rol-sintetico-propio> \
  ./scripts/verify-project.sh --section reticulum \
  --evidence-dir /ruta/privada/fuera-del-checkout
```

Antes: instancia temporal propia0700, PostgreSQL instalado existente,
loopback/puerto libre, role sintético y postmaster.pid ligado a UID/PID,
data_directory/puerto/socket_dir/listen_addresses/tiempo de arranque.
Readback SQL de la misma identidad antes de `mix test`, que crea/migra
`ret_test`. Después: parar solo ESE data directory/PID, verificar PID ausente.
No conectar a5432 del dueño, crear aliases de red ni usar una DB compartida
para probar si el comando funciona. Datos/credenciales de producción excluidos.

## Evidencia local, no full ni ciclos reales

- 9c7840: host127.0.0.2 no disponible en macOS, startup rechazado; log FATAL
  y `pg_ctl status` confirman servidor ausente. El servidor del dueño901 siguió
  escuchando5432. No se cambió la interfaz de red para forzar ese método.
- e24697/69560: puerto propio disponible y stop probado; oracle abortó ANTES
  de SQL porque asumía0.22.3. El lock/app reales son0.22.4, no un cache inválido.
- a917b5 exit0: el Postgrex fijado usa PGPORT sin option `port`, conecta
  realmente al servidor propio y readback data_directory/role/puerto coincide.
  PID y socket propios, stop/PID ausente comprobados.600ms caliente incluyendo
  start/SQL/stop, sin initdb; no es un SLO de copia/deploy. Scratch privado
  `/private/tmp/yn-ret-port-IsT0o9`, logs0600; source cache de F solo lectura.
- 7c5fd9 exit1: binding de puerto ausente en recibo, caso rojo exacto.
- 907302/38872 exit0:29 tests normales, diez nuevos: binding default,
  invalidación Reticulum/compatibilidad Dialog, forwarding default/custom y
  seis puertos inválidos antes de Mix. Bash syntax/ShellCheck/diff finales
  PASS, sin repetir29 tras un comentario de lint. No mocks como SQL real.
- 33991 exit1 REAL en la sección estándar: deps/formato/compile pasaron,
  migración intentó5432 por el default Ecto; salida denegada por sandbox.
  Summary terminalFAIL, section_exit1, stopped=true, PID propio25175 ausente;
  scratch0700 `/private/tmp/yn-ret-full-ndUhKs`, logs0600,28.373s. No recibo
  Reticulum aprobado ni causalidad histórica de multimedia inventada.
- da0b99 exit2: ocho tests nuevos de `Config.Reader` fallan antes del cambio;
  e4012f exit0:8/8 después. Default/custom se exigen en LAS TRES conexiones
  y los seis puertos inválidos fallan al leer config, antes de abrir SQL.
  Esto verifica configuración, no sustituye la sección completa con DB real.

Revisión primaria separada, no independiente: valor cerrado antes de arithmetic,
PGHOST no reemplaza DB_HOST explícito, credenciales no impresas, default CI
conservado y puerto ligado a evidencia. La vida/identidad del servidor propio
debe probarse en la ejecución integral, no inferirse de este canary.
Scanner final, commit, sesión integral y cierre se registran en PLAN. No se
declara aquí full exacto, firmas/imágenes oficiales, Kubernetes o Goal completo.
