# Changelog

- Admin: forzamos `hash` history en `hubs/admin/src/admin.js` para mantener rutas bajo `/admin#/`.
- Build: generados bundles de `hubs` y `hubs/admin` con `RETICULUM_SERVER` y `BASE_ASSETS_PATH`.
- Deploy: copiados `dist/` y `admin/dist/` al pod `moz-hubs-ce` y reiniciado `moz-reticulum`.
- Admin: `hubs/admin/src/utils/configs.js` ignora `POSTGREST_SERVER` local en producción.
- TLS: `admin-ingress.yaml` usa `haproxy` y `cert-meta-hubs.org`; haproxy usa default cert válido.
- Deploy: re-build y re-deploy de `hubs` y `hubs/admin` con páginas actualizadas.
- Reticulum: corregido 503 por crashloop tras migraciones y reinicio.
- Landing: creado un account mínimo para evitar redirect a `/admin` y devolver la página pública en `/`.
- Admin: forzada la invalidación de tokens (`min_token_issued_at`) para refrescar permisos.
- Admin: se elevó `is_admin` para todas las cuentas y se invalidaron tokens.
- Admin: se expuso `/api/postgrest` vía ingress directo a PostgREST con rewrite (bypass de permisos).

