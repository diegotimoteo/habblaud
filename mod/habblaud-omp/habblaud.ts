// Extensão do Habblaud para o omp (oh-my-pi): carregada pelo omp 18+ de <pasta do omp>/extensions/habblaud.ts (o
// instalador, scripts/omp-install.ts, grava lá um arquivo de uma linha que reexporta este). Roda dentro do Bun do omp,
// fora do projeto: só node:* e fetch, e o único import do Habblaud é de tipos (apagado na carga) e do
// shared/omp-events.ts, que não tem dependências.
//
// O que faz (design 2, 4 e 5 da mudança suporte-ao-omp):
//
// 1. Eventos: session_start, agent_start, agent_end, tool_execution_start/_end, tool_approval_requested/_resolved e
//    session_shutdown viram POST http://127.0.0.1:<porta>/api/omp/events (um OmpEvent, ver shared/omp-events.ts), mais
//    um batimento a cada 10 s: é ele que diz ao servidor que a sessão está viva (sem batimento por 30 s ela é dada
//    como encerrada). Porta: HABBLAUD_PORT no ambiente do omp › ~/.habblaud/omp-extension.json {"port"} › 4747, lida a
//    cada conexão. Nenhuma falha de rede chega ao omp: fetch com prazo de 2 s, erro engolido, e os eventos saem em
//    fila, um de cada vez (a ordem importa), sem acumular quando o Habblaud trava.
// 2. Mensagens: laço inbox → entrega → ack com as rotas existentes (POST /api/mod/inbox e /api/mod/inbox/ack,
//    `session` = id da sessão do omp). A pergunta também marca a presença da caixa de mensagem no escritório. Cada
//    mensagem entra por pi.sendUserMessage: com o agente no meio de um turno, como {deliverAs: 'followUp'} (depois
//    dele, sem interromper as ferramentas); livre, SEM deliverAs, que no omp 18.12 inicia um turno novo (com
//    deliverAs 'followUp' e o agente livre o omp só enfileira e a mensagem esperaria o próximo pedido). Perguntas a cada 2 s à toa, 5 s com o agente ocupado (a presença vale 10 s no
//    servidor), 30 s com o Habblaud fora do ar, sem as mensagens ligadas (403) ou respondendo qualquer coisa que
//    não seja 2xx.
// 3. Permissões, só com HABBLAUD_OMP_PERMISSOES=1 no ambiente do omp (modo de decisão): no `tool_call` de ferramenta
//    que não é só de leitura, abre ao mesmo tempo um pedido no Habblaud (POST /api/permissions, provider "omp") e,
//    com UI, um diálogo no terminal (ctx.ui.confirm com signal). A primeira resposta decide e fecha a outra: o
//    diálogo é cancelado, ou o pedido é retirado do escritório (POST /api/permissions/:id/decision
//    {behavior: "terminal"}). Recusa = {block, reason} (o motivo vai ao modelo). O prazo: com UI, a espera do
//    Habblaud (5 min: o omp não conta o prazo dos handlers com um diálogo da extensão aberto); sem UI,
//    HABBLAUD_OMP_TIMEOUT_MS (o `extensionHandlers.toolCallTimeoutMs` do omp, 30 000 por padrão) menos 3 s. Sem
//    resposta: "sem resposta a tempo". Habblaud que não aceita o registro em 2 s: só o diálogo (sem UI: recusa "Habblaud
//    fora do ar"). Esse modo é para o omp em --approval-mode yolo; em outro modo, um aviso único por sessão.
//
// Subagentes (ctx.agent.kind === 'sub'): o omp refaz as extensões para cada um; eles não mandam eventos nem
// perguntam o inbox (o escritório já vê os subagentes pelo arquivo da sessão), mas as ferramentas deles passam pelo
// modo de decisão, no nome da sessão principal.
//
// Textos que vão ao modelo ou ao terminal do omp são em português fixo: a extensão roda fora do Habblaud, sem o tr().
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OMP_HEARTBEAT_MS, type OmpEvent, type OmpEventKind } from '../../shared/omp-events';

export const DEFAULT_PORT = 4747;
/** Quanto esperar o Habblaud responder (qualquer rota). */
export const FETCH_TIMEOUT_MS = 2_000;
export const INBOX_IDLE_MS = 2_000;
export const INBOX_BUSY_MS = 5_000;
export const INBOX_OFFLINE_MS = 30_000;
/** Tamanho máximo do motivo de uma falha de entrega. */
export const MAX_REASON = 500;
/** Espera do Habblaud pelo pedido de permissão com o diálogo aberto (o padrão do servidor: DEFAULT_TIMEOUT_MS). */
export const DECISION_UI_MS = 300_000;
/** `extensionHandlers.toolCallTimeoutMs` padrão do omp. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;
/** Folga de uma recusa por prazo sobre o `toolCallTimeoutMs` (o omp bloqueia o handler nesse prazo). */
export const NO_UI_MARGIN_MS = 3_000;
export const MIN_DECISION_MS = 1_000;
/** Duração de cada long-poll de GET /api/permissions/:id/wait (s): o servidor corta em 25 s. */
const POLL_SECONDS = 25;
/** Fila de eventos: passando disso o Habblaud está travado e os eventos novos de ferramenta são largados. */
const MAX_QUEUE = 32;
const MAX_DIALOG_DETAIL = 800;

/**
 * Ferramentas só de leitura do omp: nunca entram no modo de decisão. O omp não expõe o nível da ferramenta ao
 * `tool_call`, então a lista é fixa (a base é READ_ONLY_TOOL_NAMES do omp, task/read-only-policy.ts); o que não está
 * aqui conta como `write`/`exec`, o mesmo padrão do omp para ferramenta sem nível declarado: pede mais, não menos.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'wait',
  'grep',
  'glob',
  'find',
  'ls',
  'web_search',
  'fetch',
  'lsp',
  'jfind',
  'ast_grep',
  'yield',
  'ask',
  'todo',
  'think',
  'recall',
  'reflect',
  'retain',
  'memory_edit',
  'checkpoint',
  'rewind',
  'vibe_list',
]);

// ---------------------------------------------------------------------------------------------
// O que a extensão enxerga do omp (só o que usa; o pacote do omp não é dependência)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

export interface OmpContext {
  hasUI: boolean;
  cwd?: string;
  agent?: { kind?: string };
  /** O agente está livre (não está num turno). */
  isIdle?(): boolean;
  ui: {
    confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
  sessionManager: {
    getSessionId(): string;
    getSessionFile?(): string | undefined;
    getCwd?(): string;
  };
}

export interface OmpApi {
  on(event: string, handler: (event: Rec, ctx: OmpContext) => unknown): void;
  sendUserMessage(text: string, options?: { deliverAs?: 'followUp' }): void;
}

export interface ToolCallResult {
  block: true;
  reason: string;
}

export interface Deps {
  env: NodeJS.ProcessEnv;
  home: string;
  fetch: typeof fetch;
  now: () => number;
  /** Compartilhado entre as instâncias da extensão do mesmo processo (o omp refaz a extensão para cada subagente). */
  shared: { mainSessionId?: string };
}

const SHARED: Deps['shared'] = {};

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/omp-extension.test.ts)
// ---------------------------------------------------------------------------------------------

function validPort(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65_536 ? n : undefined;
}

/** Caminho do arquivo de configuração da extensão (o instalador grava a porta nele). */
export function configPath(home: string): string {
  return join(home, '.habblaud', 'omp-extension.json');
}

/** Porta do Habblaud: HABBLAUD_PORT › omp-extension.json › padrão. Lida a cada chamada. */
export function portOf(env: NodeJS.ProcessEnv, home: string): number {
  const fromEnv = validPort(Number.parseInt(env.HABBLAUD_PORT ?? '', 10));
  if (fromEnv) return fromEnv;
  try {
    const p = configPath(home);
    if (existsSync(p)) {
      const j: unknown = JSON.parse(readFileSync(p, 'utf8'));
      const port = j && typeof j === 'object' ? validPort((j as Rec).port) : undefined;
      if (port) return port;
    }
  } catch {
    // arquivo ilegível: porta padrão
  }
  return DEFAULT_PORT;
}

export interface InboxMessage {
  id: string;
  text: string;
}

export interface AckResult {
  id: string;
  ok: boolean;
  error?: string;
}

/**
 * Lê a resposta de POST /api/mod/inbox; fora do formato = undefined (vale "fora do ar"). Item sem id fica de fora (não
 * há como confirmá-lo); com id e sem texto, entra com texto vazio, para ser confirmado como falha.
 */
export function parseInbox(text: string): InboxMessage[] | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const list = (j as Rec).messages;
  if (!Array.isArray(list)) return undefined;
  const out: InboxMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Rec;
    if (typeof m.id !== 'string' || !m.id) continue;
    out.push({ id: m.id, text: typeof m.text === 'string' ? m.text : '' });
  }
  return out;
}

/** O motivo de uma falha numa linha só, com tamanho limitado. */
export function reasonText(raw: unknown, fallback: string): string {
  const msg = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return fallback;
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

/** O prazo do modo de decisão: com UI, a espera do Habblaud; sem UI, o prazo do omp para o handler menos a folga. */
export function decisionTimeoutMs(hasUI: boolean, env: NodeJS.ProcessEnv): number {
  if (hasUI) return DECISION_UI_MS;
  const configured = Number.parseInt(env.HABBLAUD_OMP_TIMEOUT_MS ?? '', 10);
  const total = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TOOL_CALL_TIMEOUT_MS;
  return Math.max(MIN_DECISION_MS, total - NO_UI_MARGIN_MS);
}

/** A ferramenta passa pelo modo de decisão (tudo que não é só leitura). */
export function needsDecision(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
}

/** Texto do diálogo do terminal: o que a ferramenta vai fazer, em poucas linhas. */
export function dialogDetail(toolName: string, input: unknown): string {
  const r = input && typeof input === 'object' ? (input as Rec) : undefined;
  const pick = (k: string): string | undefined => (typeof r?.[k] === 'string' && (r[k] as string).trim() ? (r[k] as string) : undefined);
  let text = pick('command') ?? pick('path') ?? pick('file_path') ?? pick('url') ?? pick('code');
  if (text === undefined) {
    try {
      text = JSON.stringify(input) ?? toolName;
    } catch {
      text = toolName;
    }
  }
  return text.length > MAX_DIALOG_DETAIL ? `${text.slice(0, MAX_DIALOG_DETAIL - 1)}…` : text;
}

// ---------------------------------------------------------------------------------------------
// A extensão
// ---------------------------------------------------------------------------------------------

type Outcome =
  | { kind: 'habblaud'; allowed: boolean; message?: string }
  | { kind: 'terminal'; allowed: boolean }
  | { kind: 'timeout' }
  /** O Habblaud largou o pedido (página fechada, pedido desconhecido). */
  | { kind: 'gone' };

interface Reply {
  status: number;
  text: string;
}

/** Espera `ms`, ou até o sinal: devolve false se foi cancelada. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  if (signal?.aborted) {
    resolve(false);
    return promise;
  }
  const done = (v: boolean) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    resolve(v);
  };
  const onAbort = () => done(false);
  const timer = setTimeout(() => done(true), ms);
  signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}

function defaultDeps(): Deps {
  return { env: process.env, home: homedir(), fetch: globalThis.fetch.bind(globalThis), now: Date.now, shared: SHARED };
}

/** Monta a extensão sobre a API `pi` do omp. Exportada para os testes (o omp usa o `export default`). */
export function create(pi: OmpApi, deps: Deps): void {
  const { env, home } = deps;
  const decisionMode = env.HABBLAUD_OMP_PERMISSOES === '1';

  let sessionId: string | undefined;
  let busy = false;
  /** O contexto da sessão principal (para perguntar se o agente está livre na hora de entregar). */
  let mainCtx: OmpContext | undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let inboxTimer: ReturnType<typeof setTimeout> | undefined;
  let inboxStarted = false;
  const warned = new Set<string>();

  // ---- rede ----------------------------------------------------------------------------------

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<Reply | undefined> {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await deps.fetch(`http://127.0.0.1:${portOf(env, home)}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      return { status: res.status, text: await res.text() };
    } catch {
      return undefined;
    }
  }

  const ok = (r: Reply | undefined): r is Reply => !!r && r.status >= 200 && r.status < 300;

  // ---- eventos (em fila: um de cada vez, na ordem) --------------------------------------------

  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;

  function emit(event: OmpEventKind, id: string, extra: Partial<OmpEvent> = {}, critical = false): Promise<unknown> {
    if (queued >= MAX_QUEUE && !critical) return Promise.resolve();
    const body: OmpEvent = { event, sessionId: id, at: deps.now(), ...extra };
    queued++;
    const sent = queue.then(() => request('POST', '/api/omp/events', body)).finally(() => queued--);
    queue = sent;
    return sent;
  }

  function sessionFields(ctx: OmpContext): Partial<OmpEvent> {
    const out: Partial<OmpEvent> = {};
    try {
      const file = ctx.sessionManager.getSessionFile?.();
      if (file) out.sessionFile = file;
      const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
      if (cwd) out.cwd = cwd;
    } catch {
      // contexto já descartado: só o id
    }
    return out;
  }

  /** O id da sessão do contexto; sessão nova (início ou troca dentro do processo) = fecha a anterior e abre a nova. */
  function track(ctx: OmpContext): string | undefined {
    let id: string | undefined;
    try {
      id = ctx.sessionManager.getSessionId();
    } catch {
      return sessionId;
    }
    if (!id) return sessionId;
    if (id === sessionId) mainCtx = ctx;
    if (id !== sessionId) {
      if (sessionId) void emit('session_shutdown', sessionId);
      sessionId = id;
      mainCtx = ctx;
      deps.shared.mainSessionId = id;
      busy = false;
      void emit('session_start', id, sessionFields(ctx));
      startLoops();
    }
    return id;
  }

  function startLoops(): void {
    if (closed) return;
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        if (sessionId) void emit('heartbeat', sessionId);
      }, OMP_HEARTBEAT_MS);
      heartbeat.unref?.();
    }
    if (!inboxStarted) {
      inboxStarted = true;
      scheduleInbox(0);
    }
  }

  const isSub = (ctx: OmpContext): boolean => ctx.agent?.kind === 'sub';

  /** Registra um handler de observação: nunca lança, e subagentes ficam de fora. */
  function observe(name: string, run: (event: Rec, ctx: OmpContext, id: string) => void): void {
    pi.on(name, (event, ctx) => {
      try {
        if (isSub(ctx)) return;
        const id = track(ctx);
        if (id) run(event, ctx, id);
      } catch {
        // nenhum erro chega ao omp
      }
    });
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

  // `pi.on` aceita qualquer nome sem erro (nome errado nunca dispara): cada nome abaixo foi conferido em
  // extensibility/extensions/types.ts do omp e provado contra um omp real (tarefa 5.1).
  observe('session_start', () => {
    // track() já anunciou a sessão.
  });
  observe('agent_start', (_e, _c, id) => {
    busy = true;
    void emit('agent_start', id);
  });
  observe('agent_end', (_e, _c, id) => {
    busy = false;
    void emit('agent_end', id);
  });
  observe('tool_execution_start', (e, _c, id) => {
    void emit('tool_start', id, { toolName: str(e.toolName), toolCallId: str(e.toolCallId) });
  });
  observe('tool_execution_end', (e, _c, id) => {
    void emit('tool_end', id, { toolName: str(e.toolName), toolCallId: str(e.toolCallId) });
  });
  observe('tool_approval_requested', (e, ctx, id) => {
    void emit('approval_requested', id, { toolName: str(e.toolName), toolCallId: str(e.toolCallId) });
    // Modo de decisão com o omp perguntando também: duas perguntas por ferramenta (aviso único por sessão).
    if (decisionMode && e.approvalMode !== 'yolo' && !warned.has(id)) {
      warned.add(id);
      try {
        ctx.ui.notify('Habblaud: o modo de decisão (HABBLAUD_OMP_PERMISSOES=1) funciona com o omp em --approval-mode yolo; neste modo o omp também vai perguntar, e você verá duas perguntas por ferramenta.', 'warning');
      } catch {
        // sem UI para o aviso
      }
    }
  });
  observe('tool_approval_resolved', (e, _c, id) => {
    void emit('approval_resolved', id, { toolName: str(e.toolName), toolCallId: str(e.toolCallId), ...(typeof e.approved === 'boolean' ? { approved: e.approved } : {}) });
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    try {
      if (isSub(ctx)) return;
      const id = sessionId ?? track(ctx);
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(inboxTimer);
      heartbeat = inboxTimer = undefined;
      if (id) {
        sessionId = undefined;
        await emit('session_shutdown', id, {}, true);
      }
    } catch {
      // nenhum erro chega ao omp
    }
  });

  // ---- mensagens -----------------------------------------------------------------------------

  function scheduleInbox(ms: number): void {
    if (closed) return;
    inboxTimer = setTimeout(() => void inboxRound(), ms);
    inboxTimer.unref?.();
  }

  /** O agente está livre agora? Pergunta ao omp; sem resposta (contexto descartado), vale o que os eventos disseram. */
  function idleNow(): boolean {
    try {
      const idle = mainCtx?.isIdle?.();
      if (typeof idle === 'boolean') return idle;
    } catch {
      // contexto descartado
    }
    return !busy;
  }

  /**
   * Entrega cada mensagem, na ordem. Nunca lança. A primeira, com o agente livre, inicia um turno; o que vier depois
   * (da mesma rodada ou com o agente ocupado) entra como continuação, depois do turno atual.
   */
  function deliver(messages: readonly InboxMessage[]): AckResult[] {
    let idle = idleNow();
    return messages.map((m): AckResult => {
      if (!m.text.trim()) return { id: m.id, ok: false, error: 'mensagem vazia' };
      try {
        if (idle) {
          pi.sendUserMessage(m.text);
          idle = false;
        } else pi.sendUserMessage(m.text, { deliverAs: 'followUp' });
        return { id: m.id, ok: true };
      } catch (err) {
        return { id: m.id, ok: false, error: reasonText(err, 'falha ao entregar a mensagem') };
      }
    });
  }

  /** Uma rodada: pergunta, entrega, confirma. Uma por vez (o próximo agendamento só sai no fim). */
  async function inboxRound(): Promise<void> {
    let next = busy ? INBOX_BUSY_MS : INBOX_IDLE_MS;
    try {
      const session = sessionId;
      if (!session) {
        next = INBOX_IDLE_MS;
      } else {
        const res = await request('POST', '/api/mod/inbox', { session });
        const messages = ok(res) ? parseInbox(res.text) : undefined;
        if (!messages) next = INBOX_OFFLINE_MS;
        else if (messages.length) {
          const results = deliver(messages);
          await request('POST', '/api/mod/inbox/ack', { session, results });
        }
      }
    } catch {
      next = INBOX_OFFLINE_MS;
    }
    scheduleInbox(next);
  }

  // ---- permissões (modo de decisão) ------------------------------------------------------------

  async function register(sid: string, toolName: string, input: unknown, cwd: string, timeoutMs: number): Promise<{ id?: string; skip?: string } | undefined> {
    const res = await request('POST', '/api/permissions', { provider: 'omp', session_id: sid, tool_name: toolName, tool_input: input ?? {}, cwd, timeout_ms: timeoutMs });
    if (!ok(res)) return undefined;
    try {
      const j = JSON.parse(res.text) as Rec;
      if (res.status === 201 && typeof j.id === 'string') return { id: j.id };
      if (typeof j.skip === 'string') return { skip: j.skip };
    } catch {
      // resposta fora do formato = fora do ar
    }
    return undefined;
  }

  /** Long-poll até o Habblaud decidir, largar o pedido ou o sinal cancelar. */
  async function poll(id: string, signal: AbortSignal): Promise<Outcome | undefined> {
    while (!signal.aborted) {
      const res = await request('GET', `/api/permissions/${encodeURIComponent(id)}/wait?timeout=${POLL_SECONDS}`, undefined, signal, (POLL_SECONDS + 5) * 1_000);
      if (signal.aborted) return undefined;
      if (!res) {
        await sleep(1_000, signal);
        continue;
      }
      if (res.status === 404) return { kind: 'gone' };
      if (!ok(res)) {
        await sleep(1_000, signal);
        continue;
      }
      let j: Rec;
      try {
        j = JSON.parse(res.text) as Rec;
      } catch {
        await sleep(1_000, signal);
        continue;
      }
      if (j.status === 'decided') {
        if (j.behavior === 'allow') return { kind: 'habblaud', allowed: true };
        if (j.behavior === 'deny') return { kind: 'habblaud', allowed: false, message: str(j.message) };
        return { kind: 'gone' };
      }
      if (j.status === 'released') return j.reason === 'expired' ? { kind: 'timeout' } : { kind: 'gone' };
    }
    return undefined;
  }

  /** Retira o pedido do escritório (decidido no terminal): o servidor o solta como `released/terminal`. */
  function withdraw(id: string): Promise<unknown> {
    return request('POST', `/api/permissions/${encodeURIComponent(id)}/decision`, { behavior: 'terminal' });
  }

  const block = (reason: string): ToolCallResult => ({ block: true, reason });

  async function decide(toolName: string, input: unknown, ctx: OmpContext): Promise<ToolCallResult | undefined> {
    let sid: string | undefined;
    try {
      sid = isSub(ctx) ? deps.shared.mainSessionId : track(ctx);
    } catch {
      sid = undefined;
    }
    const hasUI = ctx.hasUI === true;
    const timeoutMs = decisionTimeoutMs(hasUI, env);
    let cwd = '';
    try {
      cwd = ctx.cwd ?? ctx.sessionManager.getCwd?.() ?? '';
    } catch {
      // contexto descartado
    }

    const reg = sid ? await register(sid, toolName, input, cwd, timeoutMs) : undefined;
    const requestId = reg?.id;
    if (!requestId && !hasUI) {
      return block(reg?.skip ? `Habblaud não pôde decidir esta ferramenta (${reg.skip})` : 'Habblaud fora do ar');
    }

    const abort = new AbortController();
    const entries: Array<Promise<Outcome>> = [];
    const never = <T>(): Promise<T> => Promise.withResolvers<T>().promise;

    // O prazo: com o diálogo aberto o omp não conta o tempo do handler, então a espera vai até timeoutMs.
    entries.push(sleep(timeoutMs, abort.signal).then((elapsed): Outcome | Promise<Outcome> => (elapsed ? { kind: 'timeout' } : never<Outcome>())));
    if (hasUI) {
      const detail = dialogDetail(toolName, input);
      entries.push(
        Promise.resolve()
          .then(() => ctx.ui.confirm(`Habblaud: permitir ${toolName}?`, detail, { signal: abort.signal }))
          .then((allowed): Outcome | Promise<Outcome> => (abort.signal.aborted ? never<Outcome>() : { kind: 'terminal', allowed: allowed === true }))
          .catch(() => never<Outcome>()),
      );
    }
    if (requestId) {
      entries.push(
        poll(requestId, abort.signal).then((o): Outcome | Promise<Outcome> => {
          if (!o) return never<Outcome>();
          // Com o diálogo aberto, um pedido largado pelo Habblaud deixa a decisão com o terminal.
          return o.kind === 'gone' && hasUI ? never<Outcome>() : o;
        }),
      );
    }

    const outcome = await Promise.race(entries);
    abort.abort();
    if (outcome.kind === 'terminal' && requestId) await withdraw(requestId);

    switch (outcome.kind) {
      case 'habblaud':
        return outcome.allowed ? undefined : block(outcome.message ?? 'recusado no Habblaud');
      case 'terminal':
        return outcome.allowed ? undefined : block('recusado no terminal');
      case 'timeout':
        return block('sem resposta a tempo');
      case 'gone':
        return block('pedido encerrado no Habblaud');
    }
  }

  if (decisionMode) {
    pi.on('tool_call', async (event, ctx) => {
      try {
        const toolName = str(event.toolName);
        if (!toolName || !needsDecision(toolName)) return undefined;
        return await decide(toolName, event.input, ctx);
      } catch (err) {
        // Falha inesperada do modo de decisão: recusa (o modo é opt-in: na dúvida, não executa).
        return block(`erro no Habblaud: ${reasonText(err, 'falha inesperada')}`);
      }
    });
  }
}

export default function habblaud(pi: OmpApi): void {
  create(pi, defaultDeps());
}
