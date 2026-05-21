import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LocalPublisherConfig {
  token: string;
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
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${filePath}.tmp`, filePath);
}

export async function clearLocalPublisherConfig(
  configDir = defaultConfigDir(),
): Promise<void> {
  await rm(configFilePath(configDir), { force: true });
}

export async function resolvePublisherToken(
  input: {
    env?: NodeJS.ProcessEnv;
    configDir?: string;
  } = {},
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
