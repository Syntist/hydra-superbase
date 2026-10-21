# Linux packages with Podman

The host needs Git, Bash and rootless Podman. Node, Yarn, Rust, MinGW and native
build dependencies run inside the container; do not run `yarn install` on the host.
The current builder supports Linux x86_64 hosts and uses Debian 13, Node 24.16.0
and Rust 1.98.1. Packages still need a compatible Linux runtime; AppImage does not
bundle glibc or remove the native torrent bridge's glibc requirements.

## Build an AppImage

```bash
git clone --branch feature/supabase-cloud https://github.com/Syntist/hydra-superbase.git
cd hydra-superbase
cp .env.example .env.local
# Fill in your Hydra API/auth URLs and the matching public Supabase settings.
./scripts/build-linux-podman.sh --env-file .env.local
```

Packages are written to `dist/container-linux/`. The default target is AppImage.
To additionally produce DEB/RPM packages:

```bash
./scripts/build-linux-podman.sh --env-file .env.local AppImage deb rpm
```

Use only client build settings in the environment file. The Supabase service-role
key belongs on the server. `.env.local` is ignored by Git, excluded from the image
build context, and mounted read-only into the build container. Omit `--env-file`
for an unconfigured upstream build. Build commands explicitly disable publishing.

The source checkout is mounted read-only. A snapshot is copied into a Podman
volume, excluding host dependencies, native outputs and generated files. Cargo,
Yarn, Electron and compiler output caches remain in checkout-specific volumes.
Only package files are copied back to the host. The first build downloads the
image/toolchains and compiles native code; later builds reuse caches.

The image deliberately contains MinGW and the Rust Windows GNU target: Hydra's
Linux package includes a Windows prerequisite helper for Epic/Wine games.
No privileged container or FUSE device is required.

## Rebasing this fork onto a release

Keep the official repository as `origin` and your fork as `fork` in the original
working checkout. A fresh clone above calls your fork `origin`; add the official
repository as `upstream` there instead and substitute that name below.

```bash
git remote -v
git fetch origin --tags
git switch feature/supabase-cloud
# Commit or stash any local work before rebasing.
git branch backup/supabase-before-next-release
# Replace vNEXT with the actual new release tag. v4.2.0 is the current base.
git rebase --onto vNEXT v4.2.0 feature/supabase-cloud
./scripts/build-linux-podman.sh --env-file .env.local
# Rebasing rewrites your feature branch; use the lease to detect remote changes.
git push --force-with-lease fork feature/supabase-cloud
```

The Supabase integration and the container workflow are separate commits. Keep
local credentials and compiled binaries out of those commits.
