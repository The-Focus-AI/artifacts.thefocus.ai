# Use Neon Postgres for Publication metadata

Artifacts v1 will store Publication metadata in Neon Postgres while storing Artifact contents in Vercel Blob. Postgres keeps token lookup, Publisher attribution, Revision Window state, Removal state, and file manifests explicit and queryable; Neon fits the Vercel deployment path without introducing a separate application platform.
