# Info Log

- Admin dev requiere `RETICULUM_SERVER` accesible; sin backend aparecen `Failed to fetch`/CORS.
- Build prod usa `RETICULUM_SERVER="meta-hubs.org"` y `BASE_ASSETS_PATH="https://assets.meta-hubs.org/hubs/"`.
- Hot-fix DO: copiar `hubs/dist/*` y `hubs/admin/dist/*` a `/www/hubs/`, luego actualizar `/www/hubs/pages/hub.html` y `/www/hubs/pages/admin.html`, reiniciar `moz-reticulum` en namespace `hcce`.
- `kubectl` instalado en `~/bin/kubectl` y cluster activo `hubs-ce-ams3`.
- TLS verificado con `openssl s_client` → certificado Let’s Encrypt para `meta-hubs.org`.
- Reticulum 503: causa por error `ret0.app_configs`/migraciones; se ejecutó job de migración y reinicio.
- Landing pública requiere al menos 1 cuenta en `ret0.accounts` para evitar redirect a `/admin`.
- Para refrescar permisos admin: actualizar `ret0.accounts.min_token_issued_at` obliga a re-login.
- En emergencia, `UPDATE ret0.accounts SET is_admin=true` otorga acceso admin a todas las cuentas.
- Bypass admin: ingress `moz-postgrest` + rewrite `/api/postgrest/(.*) -> /\\1` hacia servicio `postgrest` con rol anon `ret_admin`.

