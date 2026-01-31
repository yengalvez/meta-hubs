# Changelog

- Admin: forzamos `hash` history en `hubs/admin/src/admin.js` para mantener rutas bajo `/admin#/`.
- Build: generados bundles de `hubs` y `hubs/admin` con `RETICULUM_SERVER` y `BASE_ASSETS_PATH`.
- Deploy: copiados `dist/` y `admin/dist/` al pod `moz-hubs-ce` y reiniciado `moz-reticulum`.

