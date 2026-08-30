#!/usr/bin/env bash

# Strictly offline readiness gate for recreating a hibernated client. It reads
# one freeze-bundle-v1, its separately protected receipt and the local private
# values file. It never calls kubectl, doctl, a registry or any mutating API.

set -uo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'Usage: VALUES_FILE=/private/input-values.yaml %s /freeze-bundle /protected/receipt.json\n' \
    "$0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_DIR="$1"
RECEIPT_PATH="$2"
VALUES_SOURCE_FILE="${VALUES_FILE:-$SCRIPT_DIR/input-values.local.yaml}"
VALUES_FILE=""
# shellcheck source=deployment/lib/recovery-safety.sh
source "$SCRIPT_DIR/lib/recovery-safety.sh"
# shellcheck source=deployment/lib/git-provenance.sh
source "$SCRIPT_DIR/lib/git-provenance.sh"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

printf 'YenHubs greenfield reactivation preflight (offline)\n\n'

for command_name in git node jq; do
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "Comando local disponible: $command_name"
  else
    fail "Falta el comando local requerido: $command_name"
  fi
done
if yenhubs_require_clean_source_tree "$ROOT_DIR"; then
  pass 'Root y submodulos son checkouts limpios'
else
  fail 'Root y submodulos deben estar limpios, sin bytes locales ni untracked'
fi
if ! command -v shasum >/dev/null 2>&1 &&
   ! command -v sha256sum >/dev/null 2>&1; then
  fail 'Falta un verificador SHA-256 local'
fi

if [[ ! -d "$BUNDLE_DIR" || -L "$BUNDLE_DIR" ]] ||
   recovery_path_has_symlink_component "$BUNDLE_DIR"; then
  fail 'El bundle no es un directorio directo y regular'
  resolved_bundle=""
  BUNDLE_DIR=""
elif ! resolved_bundle="$(cd "$BUNDLE_DIR" && pwd -P)"; then
  fail 'No se pudo resolver el bundle'
  BUNDLE_DIR=""
else
  BUNDLE_DIR="$resolved_bundle"
  pass 'Bundle directo y sin enlaces'
fi

if ! recovery_require_regular_direct_file "$RECEIPT_PATH" ||
   recovery_path_has_symlink_component "$RECEIPT_PATH"; then
  fail 'El recibo protegido no es un fichero directo y regular'
  resolved_receipt=""
  RECEIPT_PATH=""
elif ! resolved_receipt="$(cd "$(dirname "$RECEIPT_PATH")" && pwd -P)/$(basename "$RECEIPT_PATH")"; then
  fail 'No se pudo resolver el recibo protegido'
  RECEIPT_PATH=""
else
  RECEIPT_PATH="$resolved_receipt"
  case "$RECEIPT_PATH" in
    "$BUNDLE_DIR"/*) fail 'El recibo protegido debe estar fuera del bundle' ;;
    *) pass 'Recibo protegido separado del bundle' ;;
  esac
  if recovery_private_values_file_is_acceptable "$RECEIPT_PATH"; then
    pass 'Recibo protegido con propietario actual y modo 0600'
  else
    fail 'El recibo protegido debe pertenecer al usuario actual y tener modo 0600'
  fi
fi

stamp=""
if [[ -n "$BUNDLE_DIR" ]] &&
   stamp="$(jq -er '.stamp | select(type == "string" and
     test("^[0-9]{8}-[0-9]{6}$"))' \
     "$BUNDLE_DIR/checkpoint-metadata.json" 2>/dev/null)" &&
   recovery_verify_freeze_bundle_directory "$BUNDLE_DIR" "$stamp"; then
  pass 'freeze-bundle-v1 completo, exacto y rehasheado'
else
  fail 'freeze-bundle-v1 invalido o incompleto'
fi

if [[ -n "$BUNDLE_DIR" && -n "$RECEIPT_PATH" ]] &&
   recovery_freeze_bundle_receipt_is_acceptable "$RECEIPT_PATH" "$BUNDLE_DIR"; then
  pass 'Dos copias, escrow, credenciales e imagenes tienen recibo recuperable'
else
  fail 'El recibo externo no liga exactamente el bundle y sus 13 imagenes'
fi

if [[ -n "$BUNDLE_DIR" ]]; then
  private_bundle=true
  while IFS= read -r artifact; do
    if ! recovery_private_values_file_is_acceptable "$BUNDLE_DIR/$artifact"; then
      private_bundle=false
      break
    fi
  done < <({ recovery_freeze_bundle_artifacts "$stamp"; printf 'SHA256SUMS\n'; } 2>/dev/null)
  if [[ "$private_bundle" == true ]]; then
    pass 'Los nueve ficheros del bundle pertenecen al usuario actual y son 0600'
  else
    fail 'Cada fichero del bundle debe pertenecer al usuario actual y ser 0600'
  fi
fi

if recovery_private_values_file_is_acceptable "$VALUES_SOURCE_FILE" &&
   node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_SOURCE_FILE" --validate >/dev/null; then
  VALUES_FILE="$VALUES_SOURCE_FILE"
  configured_keys="$(node "$SCRIPT_DIR/parse-local-values.mjs" "$VALUES_FILE" --keys |
    jq -Rsc 'split("\n") |
      map(select(endswith("=configured")) | split("=")[0]) | unique | sort')"
  required_keys="$(jq -c '
    .configured_presence | to_entries | map(select(.value == true) | .key) | sort
  ' "$BUNDLE_DIR/external-config-redacted.json" 2>/dev/null)"
  if jq -en --argjson configured "$configured_keys" --argjson required "$required_keys" '
    (($required - $configured) | length) == 0
  ' >/dev/null; then
    pass 'El conjunto privado actual contiene todas las claves declaradas'
  else
    fail 'Faltan claves privadas declaradas por el bundle'
  fi
else
  fail 'VALUES_FILE debe ser directo, valido, del usuario actual y modo 0600'
fi

if [[ -n "$BUNDLE_DIR" ]]; then
  expected_root="$(jq -er '.repositories.root.commit' "$BUNDLE_DIR/git-state.json" 2>/dev/null)"
  expected_hubs="$(jq -er '.repositories.hubs.commit' "$BUNDLE_DIR/git-state.json" 2>/dev/null)"
  expected_cloud="$(jq -er '.repositories.hubs_cloud.commit' "$BUNDLE_DIR/git-state.json" 2>/dev/null)"
  actual_root="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || :)"
  actual_hubs="$(git -C "$ROOT_DIR/hubs" rev-parse HEAD 2>/dev/null || :)"
  actual_cloud="$(git -C "$ROOT_DIR/hubs-cloud" rev-parse HEAD 2>/dev/null || :)"
  if [[ "$actual_root" == "$expected_root" && "$actual_hubs" == "$expected_hubs" &&
        "$actual_cloud" == "$expected_cloud" ]]; then
    pass 'Checkout local coincide con los tres commits congelados'
  else
    fail 'Checkout local no coincide con los tres commits congelados'
  fi
fi

if [[ -n "$BUNDLE_DIR" ]] && jq -e '
  .cost_gate.result == "approval-required-before-create" and
  (.cost_gate.checked_at_utc | type == "string")
' "$BUNDLE_DIR/infrastructure-recipe.json" >/dev/null 2>&1; then
  pass 'La receta conserva el cost gate; este preflight no autoriza crear recursos'
else
  fail 'La receta no conserva la frontera explicita de coste'
fi

if ((failures > 0)); then
  printf '\nResultado: FAIL (%s comprobaciones fallidas). No crear infraestructura.\n' \
    "$failures" >&2
  exit 1
fi

printf '\nResultado: PASS offline. El siguiente paso sigue requiriendo aprobacion explicita de coste.\n'
