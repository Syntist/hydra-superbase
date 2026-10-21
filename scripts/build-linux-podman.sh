#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
image="${HYDRA_BUILD_IMAGE:-localhost/hydra-linux-builder:node24-rust1.98.1}"
output_dir="$project_dir/dist/container-linux"
env_file=""
targets=()

usage() {
  cat <<'HELP'
Usage: ./scripts/build-linux-podman.sh [--env-file PATH] [AppImage|deb|rpm ...]

Builds Linux packages in Podman. Defaults to AppImage.
Only Podman and Bash are needed on the host; dependencies stay in volumes.
Output: dist/container-linux/

Examples:
  ./scripts/build-linux-podman.sh --env-file .env.local
  ./scripts/build-linux-podman.sh --env-file .env.local AppImage deb
HELP
}
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --env-file)
      [[ $# -ge 2 ]] || { printf 'Missing --env-file path\n' >&2; exit 2; }
      env_file="$(realpath -- "$2")"
      [[ -f "$env_file" ]] || { printf 'Environment file not found\n' >&2; exit 2; }
      shift 2 ;;
    AppImage|deb|rpm) targets+=("$1"); shift ;;
    *) printf 'Unsupported argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
((${#targets[@]})) || targets=(AppImage)
command -v podman >/dev/null || { printf 'Install Podman to use this build command.\n' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { printf 'This builder currently supports Linux x86_64 hosts.\n' >&2; exit 1; }

# Scope volumes to this checkout so unrelated forks cannot reuse its outputs.
checkout_id="$(printf '%s' "$project_dir" | sha256sum | cut -c1-12)"
volume="hydra-linux-$checkout_id"
mkdir -p "$output_dir"
podman build --file "$project_dir/containers/linux/Containerfile" \
  --tag "$image" "$project_dir/containers/linux"
args=(run --rm --userns=keep-id --user "$(id -u):$(id -g)"
  --security-opt label=disable
  --volume "$project_dir:/source:ro"
  --volume "$output_dir:/output:rw"
  --volume "$volume-work:/work:U"
  --volume "$volume-cache:/cache:U")
if [[ -n "$env_file" ]]; then
  args+=(--volume "$env_file:/run/hydra-build.env:ro")
else
  printf 'Using public Hydra defaults from .env.example; Supabase is disabled.\n'
  args+=(--volume "$project_dir/.env.example:/run/hydra-build.env:ro")
fi
podman "${args[@]}" "$image" "${targets[@]}"
printf '\nPackages: %s\n' "$output_dir"
