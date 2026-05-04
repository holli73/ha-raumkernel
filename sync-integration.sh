#!/usr/bin/env bash
# Sync the HA custom component source into the addon bundle.
#
# The addon Docker image copies ha-raumkernel-addon/teufel_raumfeld_raumkernel/
# into /integration, from where IntegrationManager auto-installs it into HA.
# The source of truth is custom_components/teufel_raumfeld_raumkernel/.
# Run this script after any Python or manifest change in custom_components/.

set -euo pipefail

SRC="$(dirname "$0")/custom_components/teufel_raumfeld_raumkernel"
DST="$(dirname "$0")/ha-raumkernel-addon/teufel_raumfeld_raumkernel"

rsync -av --delete \
  --exclude="__pycache__" \
  --exclude="*.pyc" \
  "$SRC/" "$DST/"

echo ""
echo "Sync complete: custom_components → ha-raumkernel-addon/teufel_raumfeld_raumkernel"
