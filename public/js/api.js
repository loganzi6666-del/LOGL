/** Thin wrapper over the game API. Every error comes back as a thrown Error. */

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`서버 응답을 읽을 수 없습니다 (${response.status})`);
  }
  if (!response.ok) throw new Error(payload.error ?? `요청 실패 (${response.status})`);
  return payload;
}

export const api = {
  geometry: () => request('/api/geometry'),
  playable: () => request('/api/playable'),
  state: () => request('/api/state'),
  newGame: (body) => request('/api/game/new', { method: 'POST', body }),
  interpret: (instruction, selectedProvince = null) =>
    request('/api/interpret', { method: 'POST', body: { instruction, selectedProvince } }),
  turn: (body) => request('/api/turn', { method: 'POST', body }),
  saves: () => request('/api/saves'),
  save: (name) => request('/api/save', { method: 'POST', body: { name } }),
  load: (name) => request('/api/load', { method: 'POST', body: { name } }),
};
