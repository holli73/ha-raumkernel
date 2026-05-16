#!/bin/bash
# Prepares the addon directory for Docker build by copying integration files

set -e
cd "$(dirname "$0")"

# Sync versions first
echo "Syncing versions..."
./sync-version.sh

# Sync addon JS files → custom_components so manual HACS installs stay current.
# The addon's running copies live in rootfs/app/; the integration distribution
# copies (picked up by both HACS and the Docker bundled auto-install) live in
# ../custom_components/teufel_raumfeld_raumkernel/.
echo "Syncing addon JS files to custom_components..."
cp rootfs/app/RaumkernelHelper.js ../custom_components/teufel_raumfeld_raumkernel/RaumkernelHelper.js
cp rootfs/app/tunein-patch.cjs   ../custom_components/teufel_raumfeld_raumkernel/tunein-patch.cjs

echo "Preparing build: copying integration files..."
rm -rf ./teufel_raumfeld_raumkernel
cp -r ../custom_components/teufel_raumfeld_raumkernel ./teufel_raumfeld_raumkernel

# HA Supervisor scans recursively for config.yaml — if one with the addon slug
# exists inside the bundle it gets treated as a second (no-Dockerfile) addon,
# causing "dockerfile is missing" on update. Never put config.yaml in the bundle.
rm -f ./teufel_raumfeld_raumkernel/config.yaml

echo "Done! Ready to build addon."
