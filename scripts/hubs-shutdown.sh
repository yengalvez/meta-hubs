#!/bin/bash
# Script para apagar los servicios de Hubs cuando no hay usuarios
# Esto reduce los costos de Digital Ocean escalando los pods a 0

set -e

NAMESPACE="hcce"
KUBECTL_PATH="./bin/kubectl"

echo "🔴 Apagando servicios de Hubs..."
echo "Fecha: $(date)"
echo ""

# Guardar el estado actual para poder restaurar
echo "Guardando estado actual..."
$KUBECTL_PATH get deployments -n $NAMESPACE -o json > /tmp/hubs-deployments-backup.json

# Lista de deployments que NO deben apagarse (base de datos)
KEEP_RUNNING="moz-pgsql moz-pgbouncer moz-pgbouncer-t"

# Escalar todos los deployments excepto los críticos
echo "Escalando deployments a 0 replicas..."
for deployment in $($KUBECTL_PATH get deployments -n $NAMESPACE -o jsonpath='{.items[*].metadata.name}'); do
  if [[ ! " $KEEP_RUNNING " =~ " $deployment " ]]; then
    echo "  - Apagando: $deployment"
    $KUBECTL_PATH scale deployment $deployment --replicas=0 -n $NAMESPACE
  else
    echo "  ✓ Manteniendo: $deployment (crítico)"
  fi
done

echo ""
echo "✅ Servicios apagados correctamente"
echo "💰 Estado: Solo PostgreSQL corriendo (ahorro ~60-70%)"
echo "🔄 Para volver a encender: ./scripts/hubs-startup.sh"
