# Alternative cloud-save backend

This patch routes V2 save snapshots and achievement uploads to your Supabase
project when configured. Hydra sign-in is still required: the auth bridge
validates the Hydra token and issues an owner-scoped Supabase session.
Without configuration, the official API and subscription checks remain in use.
Legacy save artifacts and Epic's own cloud service are separate workflows.

## Setup

Apply the migrations in `supabase/migrations` to your project, and deploy
`hydra-auth-bridge`. Configure `HYDRA_API_URL` for the bridge; its Supabase URL,
anon key and service-role key must be available in its server environment.
Never put the service-role key in the desktop application.

Set these build variables to the same project before building the desktop app:

- `MAIN_VITE_SUPABASE_URL`
- `MAIN_VITE_SUPABASE_ANON_KEY`
- `RENDERER_VITE_SUPABASE_URL`
- `RENDERER_VITE_SUPABASE_ANON_KEY`

Existing deployments must apply
`20261017000000_cloud_snapshot_commit_validation.sql` too. It serializes commits
per account/game, detects stale versions, and checks that every referenced blob
exists with its expected size before replacing the active snapshot.

## Validation

Automated tests cover session exchanges interrupted by logout/account changes,
failed authentication retries, first uploads, existing-blob reuse, stale versions,
storage failures, upload byte verification, owner-scoped restores, and retry
policies. The existing cloud-save tests cover conflict planning, file selection,
custom paths, removal, deletion, and restore validation.

The SQL migration and auth bridge still require a live-project check: upload and
restore on two devices, simultaneous first uploads, interrupted uploads, expired
sessions, and cross-account access rejection. No server deployment is performed
by generating or applying this patch.

Snapshot deletion removes metadata. Content-addressed storage blobs are retained;
a separate garbage collector is needed to reclaim unreferenced blobs safely.
