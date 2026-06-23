import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function writeStderr(message: string): void {
  process.stderr.write(message);
}

export interface LocalPublisherConfig {
  token: string;
}

export interface LocalPublicationState {
  localSourcePath: string;
  opaqueId: string;
  publicationUrl: string;
  revisionWindowExpiresAt: Date;
}

export interface PublicationStateStore {
  get(localSourcePath: string): Promise<LocalPublicationState | null>;
  set(state: LocalPublicationState): Promise<void>;
  clear(localSourcePath: string): Promise<void>;
}

export interface PublisherTokenLookupResult {
  token: string | null;
  source: "environment" | "local-config" | "missing";
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.THEFOCUS_ARTIFACTS_CONFIG_DIR) {
    return env.THEFOCUS_ARTIFACTS_CONFIG_DIR;
  }
  if (env.XDG_CONFIG_HOME)
    return join(env.XDG_CONFIG_HOME, "thefocus-artifacts");
  return join(env.HOME ?? homedir(), ".config", "thefocus-artifacts");
}

export function configFilePath(configDir = defaultConfigDir()): string {
  return join(configDir, "config.json");
}

export function stateFilePath(configDir = defaultConfigDir()): string {
  return join(configDir, "state.json");
}

export async function readLocalPublisherConfig(
  configDir = defaultConfigDir(),
): Promise<LocalPublisherConfig | null> {
  try {
    const raw = await readFile(configFilePath(configDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalPublisherConfig>;
    return typeof parsed.token === "string" ? { token: parsed.token } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeLocalPublisherConfig(
  config: LocalPublisherConfig,
  configDir = defaultConfigDir(),
): Promise<void> {
  const filePath = configFilePath(configDir);
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(`${filePath}.tmp`, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(`${filePath}.tmp`, filePath);
  } catch (error) {
    writeStderr(
      `Warning: could not write config to ${configDir} — ${(error as Error).message}. Set THEFOCUS_ARTIFACTS_TOKEN or $THEFOCUS_ARTIFACTS_CONFIG_DIR to work around this.\n`,
    );
  }
}

export async function clearLocalPublisherConfig(
  configDir = defaultConfigDir(),
): Promise<void> {
  await rm(configFilePath(configDir), { force: true });
}

export async function resolvePublisherToken(
  input: { env?: NodeJS.ProcessEnv; configDir?: string } = {},
): Promise<PublisherTokenLookupResult> {
  const env = input.env ?? process.env;
  if (env.THEFOCUS_ARTIFACTS_TOKEN) {
    return { token: env.THEFOCUS_ARTIFACTS_TOKEN, source: "environment" };
  }
  const config = await readLocalPublisherConfig(
    input.configDir ?? defaultConfigDir(env),
  );
  if (config?.token) return { token: config.token, source: "local-config" };
  return { token: null, source: "missing" };
}

export class InMemoryPublicationStateStore implements PublicationStateStore {
  private readonly rows = new Map<string, LocalPublicationState>();

  async get(localSourcePath: string): Promise<LocalPublicationState | null> {
    const row = this.rows.get(localSourcePath);
    return row ? cloneLocalPublicationState(row) : null;
  }

  async set(state: LocalPublicationState): Promise<void> {
    this.rows.set(state.localSourcePath, cloneLocalPublicationState(state));
  }

  async clear(localSourcePath: string): Promise<void> {
    this.rows.delete(localSourcePath);
  }
}

export class FilePublicationStateStore implements PublicationStateStore {
  constructor(private readonly configDir = defaultConfigDir()) {}

  async get(localSourcePath: string): Promise<LocalPublicationState | null> {
    const state = await this.readStateFile();
    const row = state[localSourcePath];
    return row ? parseLocalPublicationState(row) : null;
  }

  async set(state: LocalPublicationState): Promise<void> {
    const rows = await this.readStateFile();
    rows[state.localSourcePath] = {
      localSourcePath: state.localSourcePath,
      opaqueId: state.opaqueId,
      publicationUrl: state.publicationUrl,
      revisionWindowExpiresAt: state.revisionWindowExpiresAt.toISOString(),
    };
    await this.writeStateFile(rows);
  }

  async clear(localSourcePath: string): Promise<void> {
    const rows = await this.readStateFile();
    delete rows[localSourcePath];
    await this.writeStateFile(rows);
  }

  private async readStateFile(): Promise<
    Record<string, SerializedLocalPublicationState>
  > {
    try {
      const raw = await readFile(stateFilePath(this.configDir), "utf8");
      return JSON.parse(raw) as Record<string, SerializedLocalPublicationState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeStateFile(
    rows: Record<string, SerializedLocalPublicationState>,
  ): Promise<void> {
    const filePath = stateFilePath(this.configDir);
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(`${filePath}.tmp`, `${JSON.stringify(rows, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(`${filePath}.tmp`, filePath);
    } catch (error) {
      writeStderr(
        `Warning: could not write publication state to ${this.configDir} — ${(error as Error).message}. Set $THEFOCUS_ARTIFACTS_CONFIG_DIR to a writable directory.\n`,
      );
    }
  }
}

interface SerializedLocalPublicationState {
  localSourcePath: string;
  opaqueId: string;
  publicationUrl: string;
  revisionWindowExpiresAt: string;
}

function parseLocalPublicationState(
  state: SerializedLocalPublicationState,
): LocalPublicationState {
  return {
    localSourcePath: state.localSourcePath,
    opaqueId: state.opaqueId,
    publicationUrl: state.publicationUrl,
    revisionWindowExpiresAt: new Date(state.revisionWindowExpiresAt),
  };
}

function cloneLocalPublicationState(
  state: LocalPublicationState,
): LocalPublicationState {
  return {
    ...state,
    revisionWindowExpiresAt: new Date(state.revisionWindowExpiresAt),
  };
}
