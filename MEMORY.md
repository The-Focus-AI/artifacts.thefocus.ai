# artifacts.thefocus.ai MEMORY

Updated: 2026-05-22T14:25:23.064Z

## Purpose

CLI tool for publishing HTML/static artifacts to TheFocus.AI service

## Summary

Provides a command-line interface to upload files or directories, obtain a stable unlisted URL, and manage publications (list, remove, login). Uses a Publisher Token for auth and interacts with Vercel Blob storage and Neon/Postgres backend.

## Recommended Runtime

host

## Entry Points

- bin/artifacts

## Commands

- setup: mise run setup
- run: pnpm artifacts publish <path> [--title "Name"]

## Required Env Vars

- THEFOCUS_ARTIFACTS_TOKEN (required): Publisher token for authenticating with Artifacts API
- ARTIFACTS_PUBLIC_BASE_URL (optional): Base URL for publishing when targeting non‑default host

## Secret Refs

- THEFOCUS_ARTIFACTS_TOKEN

## Required CLI Tools

- node (required): Runtime for the CLI
- pnpm (required): Package manager used to install and run the CLI
- npx (optional): Allows running the CLI without global install

## Auth Requirements

- Artifacts API (required): Publish, list, and remove artifacts [secret refs: THEFOCUS_ARTIFACTS_TOKEN | tools: pnpm]
  note: Token must be issued to an email ending with @thefocus.ai
- Vercel Blob (optional): Storage backend for artifact contents [secret refs: BLOB_READ_WRITE_TOKEN]
  note: Only needed for local server development
- Neon Postgres (optional): Database for publication metadata [secret refs: DATABASE_URL]
  note: Only needed for local server development

## Host Integrations

- Vercel (required): Hosts the API functions and Blob storage [path: api/*]
- Neon (optional): Postgres database for metadata
- Clerk (optional): User authentication for the API

## Notes

- CLI commands can be run via npx @the-focus-ai/artifacts or via pnpm scripts.
- Local development requires the secret env vars DATABASE_URL and BLOB_READ_WRITE_TOKEN, but they are not needed for publishing from agents.
- The tool enforces size limits (max 25 MB per file, 100 MB total, ≤1 000 files).
