#!/usr/bin/env bash
set -euo pipefail

export HOME=/cache/home
export CARGO_HOME=/cache/cargo
export XDG_CACHE_HOME=/cache/xdg
export ELECTRON_CACHE=/cache/electron
export ELECTRON_BUILDER_CACHE=/cache/electron-builder
export YARN_CACHE_FOLDER=/cache/yarn
export HUSKY=0
export CI=1
# Build AppImages without granting the container access to /dev/fuse.
export APPIMAGE_EXTRACT_AND_RUN=1
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
mkdir -p "$HOME" "$CARGO_HOME/bin" /work/project
# Hydra resolves Cargo from CARGO_HOME rather than searching PATH.
ln -sfn /opt/cargo/bin/cargo "$CARGO_HOME/bin/cargo"

# Keep dependencies and compiler outputs in the container volume. Never copy
# host native modules, credentials, or previously generated packages.
rsync -a --delete \
  --exclude=.git --exclude=node_modules --exclude=dist --exclude=out \
  --exclude=.cache --exclude=.venv --exclude=.aws --exclude=.ssh --exclude=.env --exclude='.env.*' \
  --exclude=/hydra-native --exclude=/legendary \
  --exclude=native/hydra-native/target \
  --exclude=native/epic-prerequisite-runner/target \
  --exclude=native/torrent-bridge/build \
  --exclude=native/torrent-bridge/vcpkg_installed \
  --exclude=binaries/epic-prerequisite-runner \
  --exclude=supabase/.temp --exclude='*.patch' \
  --exclude=ludusavi/ludusavi --exclude=ludusavi/ludusavi.exe \
  /source/ /work/project/
cd /work/project
# Remove an old configuration when a later build has no --env-file.
rm -f .env.local
if [[ -f /run/hydra-build.env ]]; then
  cp /run/hydra-build.env .env.local
fi

node --input-type=module -e '
  import { existsSync } from "node:fs";
  import { validateBuildEnvironment } from "./src/shared/build-environment.ts";
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  validateBuildEnvironment(process.env);
'
yarn install --frozen-lockfile --non-interactive
yarn typecheck
rm -rf -- dist
yarn build:linux "$@" --publish never
ELECTRON_RUN_AS_NODE=1 dist/linux-unpacked/hydralauncher -e \
  'require(process.argv[1]); console.log("Packaged native addon loads successfully");' \
  "$PWD/dist/linux-unpacked/resources/hydra-native/hydra-native.node"

# Launch the actual AppImage, not just Electron in Node mode. Assert that the
# local renderer and its preload bridge initialize on a virtual display.
appimage="$(find dist -maxdepth 1 -name '*.AppImage' -print -quit)"
if [[ -n "$appimage" ]]; then
  xvfb-run -a node scripts/smoke-linux-startup.cjs "$appimage"
else
  xvfb-run -a node scripts/smoke-linux-startup.cjs dist/linux-unpacked/hydralauncher
fi

# Export packages and update metadata, not the multi-gigabyte unpacked tree.
find dist -maxdepth 1 -type f \
  \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \
  -o -name '*.blockmap' -o -name 'latest*.yml' \) \
  -exec cp -f -- {} /output/ \;
printf '\nLinux packages exported to the host output directory.\n'
