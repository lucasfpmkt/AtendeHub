/**
 * Leitura tolerante de JSON gerado por IA (compartilhado: otimizações de
 * campanhas, análise de atendimento, sugestões de follow-up).
 */

/**
 * Corrige o erro mais comum de IA ao gerar JSON: aspas duplas sem escape DENTRO
 * de um texto (ex.: "titulo":"Conjunto "Amplo" saturado") e quebras de linha cruas.
 * Uma aspa só fecha o texto se o que vem depois for estrutura JSON (, } ] :);
 * no caso da vírgula, só se depois dela vier uma nova chave ou objeto.
 */
export function fixInnerQuotes(src: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === '\\') {
      out += c + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      out += c === '\n' ? '\\n' : '';
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      const nx = src[j];
      let closes = j >= src.length || nx === '}' || nx === ']' || nx === ':';
      if (nx === ',') {
        let k = j + 1;
        while (k < src.length && /\s/.test(src[k])) k++;
        closes = src[k] === '"' || src[k] === '{' || src[k] === '[' || k >= src.length;
      }
      if (closes) {
        inStr = false;
        out += c;
      } else out += '\\"';
      continue;
    }
    out += c;
  }
  return out;
}

export function extractJson(raw: string): Record<string, unknown> {
  const plain = raw.replace(/```(?:json)?/gi, '');
  let text = plain;
  try {
    const a = plain.indexOf('{');
    JSON.parse(plain.slice(a, plain.lastIndexOf('}') + 1));
  } catch {
    text = fixInnerQuotes(plain); // aspas soltas/quebras de linha dentro dos textos
  }
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  // Só a lista: [ {...}, {...} ]
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart) && !/"sugestoes"\s*:/.test(text.slice(0, arrStart + 1))) {
    const end = text.lastIndexOf(']');
    if (end > arrStart) {
      try {
        return { sugestoes: JSON.parse(text.slice(arrStart, end + 1)) };
      } catch {
        /* tenta como objeto abaixo */
      }
    }
  }
  if (objStart < 0) throw new Error('sem JSON');
  const body = text.slice(objStart);
  try {
    return JSON.parse(body.slice(0, body.lastIndexOf('}') + 1));
  } catch {
    // Cortado: recua até o fim de uma sugestão completa e fecha a lista/objeto.
    let cut = body.lastIndexOf('}');
    for (let i = 0; i < 40 && cut > 0; i++) {
      for (const close of [']}', '}]}', '"}]}']) {
        try {
          return JSON.parse(body.slice(0, cut + 1) + close);
        } catch {
          /* próxima tentativa */
        }
      }
      cut = body.lastIndexOf('}', cut - 1);
    }
    throw new Error('JSON inválido');
  }
}


type Llm = { provider: string; model: string; complete(o: { system: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }): Promise<string> };

const preview = (s: string) => (s.trim() ? `"${s.trim().replace(/\s+/g, ' ').slice(0, 300)}…"` : '(resposta vazia)');

/**
 * Pede JSON à IA e devolve já interpretado por `parse`. Se não vier aproveitável,
 * tenta de novo (texto → converter; vazio → repetir com mais espaço).
 */
export async function askJson<T>(llm: Llm, system: string, payload: string, parse: (raw: string) => T, maxTokens = 6000): Promise<T> {
  const first = await llm.complete({ system, messages: [{ role: 'user', content: payload }], maxTokens });
  try {
    return parse(first);
  } catch {
    /* segunda tentativa */
  }
  const retry = first.trim()
    ? `Converta a resposta abaixo para o formato JSON pedido. Responda SOMENTE com o JSON, começando com { e terminando com }.\n\n${first.slice(0, 15000)}`
    : `${payload}\n\nResponda SOMENTE com o JSON pedido, começando com { e terminando com }. Seja objetivo.`;
  const second = await llm.complete({ system, messages: [{ role: 'user', content: retry }], maxTokens: Math.max(maxTokens, 8000) });
  try {
    return parse(second);
  } catch (err) {
    console.error(`[ia-json] resposta não aproveitável (${llm.provider}/${llm.model}): 1ª ${preview(first)} | 2ª ${preview(second)}`);
    throw new Error(
      `A IA (${llm.provider} · ${llm.model}) não devolveu no formato esperado (${(err as Error).message}). Início da resposta: ${preview(second || first)}`,
    );
  }
}
