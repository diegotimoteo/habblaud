import { describe, expect, it } from 'vitest';
import type { RecentSession } from '../../../shared/types';
import { dayLabel, filterSessions, formatSize, groupSessionsByDay, MAX_FAVORITES, parseFavorites, parseRecentSessions, sessionKey, splitFavorites, toggleFavorite } from './history';

const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime();
const at = (day: number, hour: number, min = 0) => new Date(2026, 9, day, hour, min).getTime();

function session(p: Partial<RecentSession> & Pick<RecentSession, 'sessionId' | 'lastAt'>): RecentSession {
  return { account: '.claude', projectDir: '-p', size: 1_000, open: false, ...p };
}

describe('sessões do Codex no histórico', () => {
  it('parseRecentSessions guarda o provider só quando é o Codex; a busca acha "codex"', () => {
    const list = parseRecentSessions({
      sessions: [
        { account: '.codex', provider: 'codex', sessionId: 'x', projectDir: '/p', lastAt: 2, size: 1, open: false },
        { account: '.claude', provider: 'claude', sessionId: 'c', projectDir: '-p', lastAt: 1, size: 1, open: false },
        { account: '.claude', provider: 'outro', sessionId: 'd', projectDir: '-p', lastAt: 0, size: 1, open: false },
      ],
    });
    expect(list.map((s) => [s.sessionId, s.provider])).toEqual([
      ['x', 'codex'],
      ['c', undefined],
      ['d', undefined],
    ]);
    expect(filterSessions(list, 'codex').map((s) => s.sessionId)).toEqual(['x']);
  });
});

describe('groupSessionsByDay', () => {
  it('Hoje, Ontem e datas, do dia mais recente para o mais antigo (e da mais recente para a mais antiga dentro do dia)', () => {
    const list = [
      session({ sessionId: 'a', lastAt: at(8, 9) }),
      session({ sessionId: 'b', lastAt: at(6, 23, 59) }),
      session({ sessionId: 'c', lastAt: at(8, 14) }),
      session({ sessionId: 'd', lastAt: at(7, 0, 5) }),
      session({ sessionId: 'e', lastAt: at(2, 10) }),
    ];
    const days = groupSessionsByDay(list, NOW);
    expect(days.map((d) => [d.label, d.sessions.map((s) => s.sessionId)])).toEqual([
      ['Hoje', ['c', 'a']],
      ['Ontem', ['d']],
      [dayLabel(at(6, 12), NOW), ['b']],
      [dayLabel(at(2, 12), NOW), ['e']],
    ]);
    expect(days[2].label).toMatch(/^Ter.*06.*out/i);
    expect(days[3].label).toMatch(/^Sex.*02.*out/i);
    expect(groupSessionsByDay([], NOW)).toEqual([]);
  });
});

describe('filterSessions', () => {
  const list = [
    session({ sessionId: 'a', lastAt: 3, title: 'Configuração do carrinho', project: '/Users/ana/projetos/loja' }),
    session({ sessionId: 'b', lastAt: 2, title: 'Rota de login', project: '/Users/ana/projetos/api', account: '.claude-conta2' }),
    session({ sessionId: 'c', lastAt: 1, projectDir: '-Users-ana-projetos-site' }),
  ];
  const label = (id: string) => (id === '.claude-conta2' ? 'Trabalho T' : 'Pessoal P');

  it('por título ou projeto, sem diferenciar maiúsculas nem acentos; todos os termos precisam casar', () => {
    expect(filterSessions(list, 'configuracao').map((s) => s.sessionId)).toEqual(['a']);
    expect(filterSessions(list, 'LOJA').map((s) => s.sessionId)).toEqual(['a']);
    expect(filterSessions(list, 'site').map((s) => s.sessionId)).toEqual(['c']);
    expect(filterSessions(list, 'rota api').map((s) => s.sessionId)).toEqual(['b']);
    expect(filterSessions(list, 'rota loja')).toEqual([]);
  });

  it('pela conta (nome ou letra); sem termo, tudo', () => {
    expect(filterSessions(list, 'trabalho', label).map((s) => s.sessionId)).toEqual(['b']);
    expect(filterSessions(list, 'pessoal', label).map((s) => s.sessionId)).toEqual(['a', 'c']);
    expect(filterSessions(list, '  ', label)).toHaveLength(3);
  });
});

describe('parseRecentSessions', () => {
  it('aceita as válidas, ignora o resto e ordena da mais recente para a mais antiga', () => {
    const raw = {
      sessions: [
        { account: '.claude', sessionId: 's1', projectDir: '-p', project: '/p', title: 'Um', firstAt: 1, lastAt: 10, size: 99, open: false, agentId: 'x' },
        { account: '.claude', sessionId: 's2', lastAt: 20, open: true, agentId: '.claude:7' },
        { account: '.claude', lastAt: 30 },
        { sessionId: 's4', lastAt: 30 },
        { account: '.claude', sessionId: 's5', lastAt: 'ontem' },
        null,
        'x',
      ],
    };
    const out = parseRecentSessions(raw);
    expect(out.map((s) => s.sessionId)).toEqual(['s2', 's1']);
    expect(out[0]).toEqual({ account: '.claude', sessionId: 's2', projectDir: '', lastAt: 20, size: 0, open: true, agentId: '.claude:7' });
    // agentId só vale para sessão aberta.
    expect(out[1]).toEqual({ account: '.claude', sessionId: 's1', projectDir: '-p', project: '/p', title: 'Um', firstAt: 1, lastAt: 10, size: 99, open: false });
    expect(parseRecentSessions(null)).toEqual([]);
    expect(parseRecentSessions({ sessions: 'x' })).toEqual([]);
  });
});

describe('utilitários', () => {
  it('formatSize', () => {
    expect(formatSize(10)).toBe('1 KB');
    expect(formatSize(820 * 1024)).toBe('820 KB');
    expect(formatSize(3.4 * 1024 * 1024)).toBe('3,4 MB');
  });
});

describe('favoritas', () => {
  it('parseFavorites ignora lixo e duplicados', () => {
    const a = session({ sessionId: 'a', lastAt: 1 });
    expect(parseFavorites(null)).toEqual([]);
    expect(parseFavorites('x')).toEqual([]);
    expect(parseFavorites([null, 'x', { account: '.claude', lastAt: 1 }, a, a]).map(sessionKey)).toEqual(['.claude:a']);
  });

  it('splitFavorites: versão do servidor vence, retrato antigo fica encerrado, favoritas saem de rest', () => {
    const savedA = session({ sessionId: 'a', lastAt: 1, title: 'velho' });
    const savedOld = session({ sessionId: 'old', lastAt: 5, title: 'antiga' });
    const serverA = session({ sessionId: 'a', lastAt: 9, title: 'novo', open: true, agentId: 'ag' });
    const other = session({ sessionId: 'b', lastAt: 3 });
    const { favorites, rest, updated } = splitFavorites([savedA, savedOld], [other, serverA]);
    expect(favorites.map((s) => [s.sessionId, s.title, s.open, s.agentId])).toEqual([
      ['a', 'novo', true, 'ag'],
      ['old', 'antiga', false, undefined],
    ]);
    expect(rest.map((s) => s.sessionId)).toEqual(['b']);
    expect(updated.map((s) => [s.sessionId, s.title, s.open, s.agentId, s.lastAt])).toEqual([
      ['a', 'novo', false, undefined, 9],
      ['old', 'antiga', false, undefined, 5],
    ]);
  });

  it('toggleFavorite adiciona, remove e respeita MAX_FAVORITES', () => {
    const s = session({ sessionId: 'a', lastAt: 1, open: true, agentId: 'ag' });
    const added = toggleFavorite([], s);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ sessionId: 'a', open: false });
    expect(added[0]?.agentId).toBeUndefined();
    expect(toggleFavorite(added, s)).toEqual([]);

    const many = Array.from({ length: MAX_FAVORITES }, (_, i) => session({ sessionId: `s${i}`, lastAt: 100 + i }));
    const capped = toggleFavorite(many, session({ sessionId: 'novo', lastAt: 1000 }));
    expect(capped).toHaveLength(MAX_FAVORITES);
    expect(capped.some((x) => x.sessionId === 'novo')).toBe(true);
    expect(capped.some((x) => x.sessionId === 's0')).toBe(false);
  });
});
