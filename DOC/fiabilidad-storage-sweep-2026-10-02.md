# Barrido multimedia: inventario durable sin consulta duplicada

Delta solo raíz, después del full local7ae65c5 y medición positiva original.
La medición completa conserva48 oráculos/13 hashes y tarda436,195s, con112s
en storage; ese tiempo incluye preparación/guardas, no solo tar/gzip. No
se atribuye a esta duplicación toda esa latencia ni el incidente histórico.

## Cambio y frontera conservada

`require_parent_checkpoint_guards` conserva operation-lock y writer authority.
En durable-v2 usa el validador COMPLETO existente del padre durable, que
llama al mismo `recovery_require_checkpoint_runner_quiescence_exact` con
los mismos baseline/path/hash, además de Lease/lock, authority/progress,
PID/start identity, inventario de runners/fence y estado active. Se retira
solo la consulta exacta anterior que ese validador vuelve a efectuar.

Legacy conserva AMBAS consultas existentes en su monitor. No se retira su
segunda observación ni se confunde con una frontera equivalente posterior.
Freeze conserva su frontera real de stream y cinco consumers a cero; no
se prueba como si lanzase el monitor legacy. PGSQL, PVC/helper/policy,
hashes, transporte, procesos y límites30/10s/reserva2s no cambian.

## Regresión y límites

`tests/scripts/storage-parent-sweep.test.mjs` ejecuta las funciones reales
del barrido y el validador durable completo; fixtures únicamente en sus
validadores externos. El rojo94c03a reprodujo dos lecturas de inventario
durable. El primer error48e2da fue sintaxis del test, no un rojo de producto.
El rojo legacy observó dos lecturas, que se mantienen deliberadamente.

Controles: durable una consulta con cinco fronteras de lock conservadas;
legacy dos; freeze real con cinco writers; generación desconocida rechazada.
Negativos: autoridad, Lease/lock, PVC, writer, inventario/parent-absence,
progreso/PID/baseline/fence, helper/policy/consumers y fallos alcanzados solo
dentro de quiescence y de ambas fronteras de fence. Ningún progreso tras
fallo. Estos tests deterministas no acreditan velocidad, transporte ni K8s.
Se incluyen en security nativo y CI; no sustituir las suites integrales.

Antes de aceptar rendimiento se debe ejecutar una medición completa sobre
bytes congelados nuevos, conservar48 oráculos/13 hashes y comparar fases.
Si no demuestra ahorro, no atribuirlo ni repetir buscando mejor cifra.
No heredar el full7ae65c5 para esta revisión: al congelar la entrega final,
renovar solo recibos invalidados por el finalizador nativo y exigir full0.
No publicación, nueva copia real o laboratorio productivo por este delta.
