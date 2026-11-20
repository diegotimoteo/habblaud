// Uso do plano das contas do omp: leitura da saída de `omp usage --json` (ver bin.ts, que roda o comando). Quem consulta
// os provedores (Anthropic, OpenAI, Google…) é o próprio omp, com as credenciais e o cache dele; o Habblaud não lê
// credenciais e só interpreta o JSON. Nunca usa `omp usage invalidate` nem `--force-refresh` (o cache do omp manda).
// Puro: testado em usage.test.ts com a saída real (fixtures/usage.json, já com --redact).
import type { AccountUsage, UsageWindow } from '../../../shared/types';
import { toEpochMs } from '../../accounts/usage';

export const FIVE_HOURS_MS = 5 * 3_600_000;
export const SEVEN_DAYS_MS = 7 * 86_400_000;

interface OmpLimit {
  scope?: { shared?: unknown; tier?: unknown };
  window?: { durationMs?: unknown; resetsAt?: unknown };
  amount?: { usedFraction?: unknown };
  status?: unknown;
}

interface OmpReport {
  provider?: unknown;
  fetchedAt?: unknown;
  limits?: unknown;
  notes?: unknown;
}

/**
 * Janelas de 5 h e 7 d do provedor `provider` no JSON de `omp usage --json`. Undefined = JSON inválido ou sem report
 * desse provedor. Report sem essas janelas (Ollama, Codex grátis de 30 d) -> AccountUsage sem janelas, com `note`.
 * Só entram limites compartilhados da conta (`scope.shared`, sem `tier`); de cada janela vale o primeiro. `metadata`
 * (e-mails, ids) nunca é copiado.
 */
export function parseOmpUsage(raw: string, provider: string, now: number): AccountUsage | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const reports = (data as { reports?: unknown } | null)?.reports;
  if (!Array.isArray(reports)) return undefined;
  const report = reports.find((r: OmpReport | null) => r?.provider === provider) as OmpReport | undefined;
  if (!report) return undefined;

  const fetchedAt = Math.min(now, toEpochMs(report.fetchedAt) ?? now);
  const usage: AccountUsage = { source: 'omp', ompProvider: provider, fetchedAt };
  const limits = Array.isArray(report.limits) ? (report.limits as (OmpLimit | null)[]) : [];
  let noQuota = false;
  for (const l of limits) {
    if (l?.scope?.shared !== true || l.scope.tier !== undefined) continue;
    const d = l.window?.durationMs;
    const key = d === FIVE_HOURS_MS ? 'fiveHour' : d === SEVEN_DAYS_MS ? 'sevenDay' : undefined;
    if (!key || usage[key]) continue;
    const used = l.amount?.usedFraction;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    if (l.status !== 'ok' && used >= 1) noQuota = true;
    const w: UsageWindow = { utilization: Math.min(100, Math.max(0, Math.round(used * 1000) / 10)) };
    const resetsAt = toEpochMs(l.window?.resetsAt);
    if (resetsAt !== undefined) w.resetsAt = resetsAt;
    usage[key] = w;
  }
  if (noQuota) {
    // Igual ao Codex: "sem cota" não é 0% nem 100%; as janelas ficam de fora.
    delete usage.fiveHour;
    delete usage.sevenDay;
    usage.noQuota = true;
  } else if (!usage.fiveHour && !usage.sevenDay) {
    const note = Array.isArray(report.notes) ? String(report.notes[0] ?? '') : '';
    if (note) usage.note = note;
  }
  return usage;
}

/** `anthropic/claude-opus-5-5` -> `anthropic`; sem barra ou vazio -> undefined. */
export function ompProviderOf(model: string | undefined): string | undefined {
  const i = model?.indexOf('/') ?? -1;
  return i > 0 ? model!.slice(0, i) : undefined;
}
