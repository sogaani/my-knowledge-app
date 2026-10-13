/** The collector's .env (secrets, Mac only): read-modify-write of one key, and owner-only permissions. */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const ENV_FILE_MODE = 0o600;

/** Replace or append KEY=value (keeps comments and order). The file ends up 0600 whether it existed or not. */
export function setEnvVar(file: string, key: string, value: string): void {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  writeFileSync(file, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n?$/, "\n")}${key}=${value}\n`, { mode: ENV_FILE_MODE });
  chmodSync(file, ENV_FILE_MODE); // `mode` only applies when the file is created
}

/** chmod 600 an existing .env that is more open than that. Returns true when it had to be tightened. */
export function secureEnvFile(file: string): boolean {
  if (!existsSync(file)) return false;
  if ((statSync(file).mode & 0o777) === ENV_FILE_MODE) return false;
  chmodSync(file, ENV_FILE_MODE);
  return true;
}
