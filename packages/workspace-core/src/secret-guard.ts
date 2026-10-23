import type { AssetChange } from "./asset-format.js";
import { WorkspaceError } from "./errors.js";

const secretName = /(?:^|[_-])(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth|cookie|session)s?(?:$|[_-])/i;
const secretHeader = /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;
const secretValue = /(?:^|[\s=:])(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Names the fields of a team change that appear to carry a plaintext credential.
 * Team repositories are readable by every member and keep history forever, so
 * credentials must be referenced with `fromEnv` and resolved on each machine.
 * Empty values are allowed because they declare a variable without a secret.
 */
export function plaintextSecretFields(change: Exclude<AssetChange, { kind: "batch" }>): string[] {
  const found: string[] = [];
  const check = (label: string, name: string, value: unknown, nameRule = secretName) => {
    if (typeof value === "string" && value.length > 0 && (nameRule.test(name) || secretValue.test(value))) found.push(label);
  };
  if (change.kind === "environment") check(change.value.name, change.value.name, change.value.value);
  if (change.kind !== "mcp") return found;
  const server = change.value;
  if (server.transport === "stdio") {
    server.args.forEach((arg, index) => { if (secretValue.test(arg) || /^--?[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*=./i.test(arg)) found.push(`args[${index}]`); });
    for (const [name, value] of Object.entries(server.env)) check(`env.${name}`, name, value);
  } else {
    for (const [name, value] of new URL(server.url).searchParams) check(`url?${name}`, name, value);
    for (const [name, value] of Object.entries(server.headers)) check(`headers.${name}`, name, value, secretHeader.test(name) ? /./ : secretName);
  }
  return found;
}

export function assertNoPlaintextSecrets(changes: Array<Exclude<AssetChange, { kind: "batch" }>>): void {
  for (const change of changes) {
    const fields = plaintextSecretFields(change);
    if (fields.length) throw new WorkspaceError("PLAINTEXT_SECRET", `“${change.value.name}”的 ${fields.join("、")} 看起来是明文密钥。团队仓库对所有成员可见且永久保留历史；请改为“从本机环境变量读取”，由每位成员在本机设置。`, { fields });
  }
}
