# Info Log

- Admin dev requiere `RETICULUM_SERVER` accesible; sin backend aparecen `Failed to fetch`/CORS.
- Build prod usa `RETICULUM_SERVER="meta-hubs.org"` y `BASE_ASSETS_PATH="https://assets.meta-hubs.org/hubs/"`.
- Hot-fix DO: copiar `hubs/dist/*` y `hubs/admin/dist/*` a `/www/hubs/`, luego actualizar `/www/hubs/pages/hub.html` y `/www/hubs/pages/admin.html`, reiniciar `moz-reticulum` en namespace `hcce`.
- `kubectl` instalado en `~/bin/kubectl` y cluster activo `hubs-ce-ams3`.

